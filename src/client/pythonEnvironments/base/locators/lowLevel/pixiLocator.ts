import { asyncFilter } from '../../../../common/utils/arrayUtils';
import { chain, iterable } from '../../../../common/utils/async';
import { traceError, traceVerbose } from '../../../../logging';
import { getCondaInterpreterPath } from '../../../common/environmentManagers/conda';
import { Pixi } from '../../../common/environmentManagers/pixi';
import { pathExists } from '../../../common/externalDependencies';
import { PythonEnvKind } from '../../info';
import { IPythonEnvsIterator, BasicEnvInfo } from '../../locator';
import { LazyResourceBasedLocator } from '../common/resourceBasedLocator';

/**
 * Returns all virtual environment locations to look for in a workspace.
 */
async function getVirtualEnvDirs(root: string): Promise<string[]> {
    const pixi = await Pixi.getPixi(root);
    const envDirs = (await pixi?.getEnvList()) ?? [];
    return asyncFilter(envDirs, pathExists);
}

export class PixiLocator extends LazyResourceBasedLocator {
    public readonly providerId: string = 'pixi';

    public constructor(private readonly root: string) {
        super();
    }

    protected doIterEnvs(): IPythonEnvsIterator<BasicEnvInfo> {
        async function* iterator(root: string) {
            const envDirs = await getVirtualEnvDirs(root);
            const envGenerators = envDirs.map((envDir) => {
                async function* generator() {
                    traceVerbose(`Searching for Pixi virtual envs in: ${envDir}`);
                    const filename = await getCondaInterpreterPath(envDir);
                    if (filename !== undefined) {
                        try {
                            yield {
                                executablePath: filename,
                                kind: PythonEnvKind.Pixi,
                                envPath: envDir,
                            };

                            traceVerbose(`Pixi Virtual Environment: [added] ${filename}`);
                        } catch (ex) {
                            traceError(`Failed to process environment: ${filename}`, ex);
                        }
                    }
                }
                return generator();
            });

            yield* iterable(chain(envGenerators));
            traceVerbose(`Finished searching for Pixi envs`);
        }

        return iterator(this.root);
    }
}
