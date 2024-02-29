// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import * as path from 'path';
import { OSType, getOSType, getUserHomeDir } from '../../../common/utils/platform';
import { exec, getPythonSetting, pathExists, pathExistsSync } from '../externalDependencies';
import { cache } from '../../../common/utils/decorators';
import { isTestExecution } from '../../../common/constants';
import { traceError, traceVerbose } from '../../../logging';

// This type corresponds to the output of 'pixi info --json', and property
// names must be spelled exactly as they are in order to match the schema.
export type PixiInfo = {
    platform: string;
    virtual_packages: string[]; // eslint-disable-line camelcase
    version: string;
    cache_dir: string; // eslint-disable-line camelcase
    cache_size?: number; // eslint-disable-line camelcase
    auth_dir: string; // eslint-disable-line camelcase

    project_info?: /* eslint-disable-line camelcase */ {
        manifest_path: string; // eslint-disable-line camelcase
        last_updated: string; // eslint-disable-line camelcase
        pixi_folder_size?: number; // eslint-disable-line camelcase
        version: string;
    };

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

export async function isPixiEnvironment(interpreterPath: string): Promise<boolean> {
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
    const pixiTomlPath = path.join(projectDir, 'pixi.toml');
    return pathExists(pixiTomlPath);
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
    private async getEnvListCached(_cwd: string): Promise<string[] | undefined> {
        const infoOutput = await exec(this.command, ['info', '--json'], {
            cwd: this.cwd,
            throwOnStdErr: true,
        }).catch(traceVerbose);
        if (!infoOutput) {
            return undefined;
        }

        const pixiInfo: PixiInfo = JSON.parse(infoOutput.stdout);
        return pixiInfo.environments_info.map((env) => env.prefix);
    }
}
