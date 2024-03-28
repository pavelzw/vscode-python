// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import * as path from 'path';
import { OSType, getOSType, getUserHomeDir } from '../../../common/utils/platform';
import { exec, getPythonSetting, isParentPath, pathExists, pathExistsSync } from '../externalDependencies';
import { cache } from '../../../common/utils/decorators';
import { isTestExecution } from '../../../common/constants';
import { traceError, traceVerbose, traceWarn } from '../../../logging';
import { OUTPUT_MARKER_SCRIPT } from '../../../common/process/internal/scripts';

// This type corresponds to the output of 'pixi info --json', and property
// names must be spelled exactly as they are in order to match the schema.
export type PixiInfo = {
    platform: string;
    virtual_packages: string[]; // eslint-disable-line camelcase
    version: string;
    cache_dir: string; // eslint-disable-line camelcase
    cache_size?: number; // eslint-disable-line camelcase
    auth_dir: string; // eslint-disable-line camelcase

    project_info?: PixiProjectInfo /* eslint-disable-line camelcase */;

    environments_info: /* eslint-disable-line camelcase */ {
        name: string;
        features: string[];
        solve_group: string; // eslint-disable-line camelcase
        environment_size: number; // eslint-disable-line camelcase
        dependencies: string[];
        tasks: string[];
        channels: string[];
        prefix: string;
    }[];
};

export type PixiProjectInfo = {
    manifest_path: string; // eslint-disable-line camelcase
    last_updated: string; // eslint-disable-line camelcase
    pixi_folder_size?: number; // eslint-disable-line camelcase
    version: string;
};

export async function isPixiEnvironment(interpreterPath: string): Promise<boolean> {
    const projectDir = getPixiProjectFolderFromInterpreter(interpreterPath);
    const pixiTomlPath = path.join(projectDir, 'pixi.toml');
    return pathExists(pixiTomlPath);
}

/**
 * Returns the path to the project directory based on the interpreter path.
 *
 * This function does not check if the path actually exists.
 *
 * @param interpreterPath The path to the interpreter
 */
export function getPixiProjectFolderFromInterpreter(interpreterPath: string): string {
    // We want to verify the following layout
    // project
    // |__ pixi.toml                    <-- check if this exists
    // |__ .pixi
    //     |__ envs
    //         |__ <environment>
    //             |__ bin/""
    //                 |__ python       <-- interpreterPath

    const envDir = getCondaEnvironmentFromInterpreterPath(interpreterPath);
    const envsDir = path.dirname(envDir);
    const pixiDir = path.dirname(envsDir);
    const projectDir = path.dirname(pixiDir);

    return projectDir;
}

/**
 * Returns the path to the environment directory based on the interpreter path.
 */
export function getCondaEnvironmentFromInterpreterPath(interpreterPath: string): string {
    const interpreterDir = path.dirname(interpreterPath);
    if (getOSType() === OSType.Windows) {
        return interpreterDir;
    }
    return path.dirname(interpreterDir);
}

/** Wraps the "pixi" utility, and exposes its functionality.
 */
export class Pixi {
    /**
     * Locating pixi binary can be expensive, since it potentially involves spawning or
     * trying to spawn processes; so we only do it once per session.
     */
    private static pixiPromise: Map<string, Promise<Pixi | undefined>> = new Map<string, Promise<Pixi | undefined>>();

    /**
     * Creates a Pixi service corresponding to the corresponding "pixi" command.
     *
     * @param command - Command used to run pixi. This has the same meaning as the
     * first argument of spawn() - i.e. it can be a full path, or just a binary name.
     * @param cwd - The working directory to use as cwd when running pixi.
     */
    constructor(public readonly command: string, private cwd: string) {}

    /**
     * Returns a Pixi instance corresponding to the binary which can be used to run commands for the cwd.
     *
     * Pixi commands can be slow and so can be bottleneck to overall discovery time. So trigger command
     * execution as soon as possible. To do that we need to ensure the operations before the command are
     * performed synchronously.
     */
    public static async getPixi(cwd: string): Promise<Pixi | undefined> {
        if (Pixi.pixiPromise.get(cwd) === undefined || isTestExecution()) {
            Pixi.pixiPromise.set(cwd, Pixi.locate(cwd));
        }
        return Pixi.pixiPromise.get(cwd);
    }

    private static async locate(cwd: string): Promise<Pixi | undefined> {
        // First thing this method awaits on should be pixi command execution, hence perform all operations
        // before that synchronously.

        traceVerbose(`Getting pixi for cwd ${cwd}`);
        // Produce a list of candidate binaries to be probed by exec'ing them.
        function* getCandidates() {
            // Read the pixi location from the settings.
            try {
                const custompixiToolPath = getPythonSetting<string>('pixiToolPath');
                if (custompixiToolPath && custompixiToolPath !== 'pixi') {
                    // If user has specified a custom pixi path, use it first.
                    yield custompixiToolPath;
                }
            } catch (ex) {
                traceError(`Failed to get pixi setting`, ex);
            }

            // Check unqualified filename, in case it's on PATH.
            yield 'pixi';

            // Check the default installation location
            const home = getUserHomeDir();
            if (home) {
                const defaultpixiToolPath = path.join(home, '.pixi', 'bin', 'pixi');
                if (pathExistsSync(defaultpixiToolPath)) {
                    yield defaultpixiToolPath;
                }
            }
        }

        // Probe the candidates, and pick the first one that exists and does what we need.
        for (const pixiToolPath of getCandidates()) {
            traceVerbose(`Probing pixi binary for ${cwd}: ${pixiToolPath}`);
            const pixi = new Pixi(pixiToolPath, cwd);
            const virtualenvs = await pixi.getEnvList();
            if (virtualenvs !== undefined) {
                traceVerbose(`Found pixi via filesystem probing for ${cwd}: ${pixiToolPath}`);
                return pixi;
            }
            traceVerbose(`Failed to find pixi for ${cwd}: ${pixiToolPath}`);
        }

        // Didn't find anything.
        traceVerbose(`No pixi binary found for ${cwd}`);
        return undefined;
    }

    /**
     * Retrieves list of Python environments known to this pixi for this working directory.
     * Returns `undefined` if we failed to spawn because the binary doesn't exist or isn't on PATH,
     * or the current user doesn't have execute permissions for it, or this pixi couldn't handle
     * command line arguments that we passed (indicating an old version that we do not support, or
     * pixi has not been setup properly for the cwd).
     *
     * Corresponds to "pixi info --json" and extracting the environments. Swallows errors if any.
     */
    public async getEnvList(): Promise<string[] | undefined> {
        return this.getEnvListCached(this.cwd);
    }

    /**
     * Method created to facilitate caching. The caching decorator uses function arguments as cache key,
     * so pass in cwd on which we need to cache.
     */
    @cache(30_000, true, 10_000)
    private async getEnvListCached(cwd: string): Promise<string[] | undefined> {
        const pixiInfo = await this.getPixiInfo(cwd);
        // eslint-disable-next-line camelcase
        return pixiInfo?.environments_info.map((env) => env.prefix);
    }

    @cache(1_000, true, 1_000)
    public async getPixiInfo(_cwd: string): Promise<PixiInfo | undefined> {
        const infoOutput = await exec(this.command, ['info', '--json'], {
            cwd: this.cwd,
            throwOnStdErr: false,
        }).catch(traceError);
        if (!infoOutput) {
            return undefined;
        }

        const pixiInfo: PixiInfo = JSON.parse(infoOutput.stdout);
        return pixiInfo;
    }

    public getRunPythonArgs(manifestPath: string, envName?: string, isolatedFlag = false): string[] {
        let python = [this.command, 'run', '--manifest-path', manifestPath];
        if (isNonDefaultPixiEnvironmentName(envName)) {
            python = python.concat(['--environment', envName]);
        }

        python.push('python');
        if (isolatedFlag) {
            python.push('-I');
        }
        return [...python, OUTPUT_MARKER_SCRIPT];
    }
}

/**
 * Returns true if interpreter path belongs to a pixi environment which is associated with a particular folder,
 * false otherwise.
 *
 * @param interpreterPath Absolute path to any python interpreter.
 * @param folder Absolute path to the folder.
 */
export async function isPixiEnvironmentRelatedToFolder(interpreterPath: string, folder: string): Promise<boolean> {
    const projectPath = getPixiProjectFolderFromInterpreter(interpreterPath);
    return isParentPath(folder, projectPath);
}

export type PixiEnvironmentInfo = {
    interpreterPath: string;
    pixi: Pixi;
    pixiVersion: string;
    projectInfo: PixiProjectInfo;
    projectDir: string;
    envName?: string;
};

export async function getPixiEnvironmentFromInterpreter(
    interpreterPath: string,
): Promise<PixiEnvironmentInfo | undefined> {
    const envDir = getCondaEnvironmentFromInterpreterPath(interpreterPath);
    const envsDir = path.dirname(envDir);
    const envName = path.basename(envDir);
    const pixiDir = path.dirname(envsDir);
    const projectDir = path.dirname(pixiDir);

    // Find the pixi executable for the project
    const pixi = await Pixi.getPixi(projectDir);
    if (!pixi) {
        traceWarn(`could not find a pixi interpreter for the interpreter at ${interpreterPath}`);
        return undefined;
    }

    // Invoke pixi to get information about the pixi project
    const pixiInfo = await pixi.getPixiInfo(projectDir);
    if (!pixiInfo || !pixiInfo.project_info) {
        traceWarn(`failed to determine pixi project information for the interpreter at ${interpreterPath}`);
        return undefined;
    }

    return {
        interpreterPath,
        pixiVersion: pixiInfo.version,
        projectInfo: pixiInfo.project_info,
        projectDir,
        envName,
        pixi,
    };
}

/**
 * Returns true if the given environment name is *not* the default environment.
 */
export function isNonDefaultPixiEnvironmentName(envName?: string): envName is string {
    return envName !== undefined && envName !== 'default';
}
