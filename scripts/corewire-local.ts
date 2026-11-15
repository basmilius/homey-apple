import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Copies the built packages of a local CoreWire checkout into node_modules, to test a library change
// before it is released. Real copies, no symlinks, because `homey app build` packs node_modules as is.
const PACKAGES = ['core', 'airplay', 'companion-link', 'devices', 'audio-source'];
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

// A version npm will never have, so the copy cannot be mistaken for a published release.
const LOCAL_VERSION = '0.0.0-local';

const appRoot = resolve(import.meta.dir, '..');
const libraryRoot = resolve(appRoot, process.argv[2] ?? process.env.COREWIRE_PATH ?? '../../@basmilius/apple-protocols');
const packageNames = new Set(PACKAGES.map(name => `@corewire/${name}`));

type Manifest = Record<string, unknown> & {
    readonly name: string;
    version: string;
};

function readManifest(name: string): Manifest {
    return JSON.parse(readFileSync(join(libraryRoot, 'packages', name, 'package.json'), 'utf8'));
}

for (const name of PACKAGES) {
    const source = join(libraryRoot, 'packages', name);
    const target = join(appRoot, 'node_modules', '@corewire', name);
    const manifest = readManifest(name);

    if (!existsSync(join(source, 'dist'))) {
        console.error(`${source}/dist is missing, run \`bash build.sh\` in ${libraryRoot} first.`);
        process.exit(1);
    }

    let rewritten = 0;

    for (const field of DEPENDENCY_FIELDS) {
        const dependencies = manifest[field] as Record<string, string> | undefined;

        for (const [dependency, range] of Object.entries(dependencies ?? {})) {
            if (!range.startsWith('workspace:')) {
                continue;
            }

            if (!packageNames.has(dependency)) {
                console.error(`${manifest.name} depends on ${dependency} from the workspace, which this script does not copy.`);
                process.exit(1);
            }

            dependencies[dependency] = LOCAL_VERSION;
            rewritten++;
        }
    }

    manifest.version = LOCAL_VERSION;

    rmSync(target, {recursive: true, force: true});
    mkdirSync(target, {recursive: true});
    writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 4)}\n`);
    cpSync(join(source, 'dist'), join(target, 'dist'), {recursive: true, dereference: true});

    if (existsSync(join(source, 'LICENSE'))) {
        cpSync(join(source, 'LICENSE'), join(target, 'LICENSE'));
    }

    console.log(`${manifest.name}@${manifest.version}: copied dist, rewrote ${rewritten} workspace dependencies.`);
}
