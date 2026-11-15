import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Until @corewire is on npm: copies the built packages of a local apple-protocols checkout into
// node_modules. Real copies, no symlinks, because `homey app build` packs node_modules as is.
const PACKAGES = ['opack', 'tlv8', 'core', 'airplay', 'companion-link', 'devices', 'audio-source'];
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

// A version npm will never have, so `bun install` cannot swap the copy for a published placeholder.
// package.json pins the optional dependencies to it as well.
const LOCAL_VERSION = '0.0.0-local';

const appRoot = resolve(import.meta.dir, '..');
const libraryRoot = resolve(appRoot, process.argv[2] ?? process.env.COREWIRE_PATH ?? '../../@basmilius/apple-protocols');
type Manifest = Record<string, unknown> & {
    readonly name: string;
    version: string;
};

function readManifest(name: string): Manifest {
    return JSON.parse(readFileSync(join(libraryRoot, 'packages', name, 'package.json'), 'utf8'));
}

// The npm names: `@corewire/*` for the libraries, plain `opack` and `tlv8` for the codecs.
const packageNames = new Set(PACKAGES.map(name => readManifest(name).name));

for (const name of PACKAGES) {
    const source = join(libraryRoot, 'packages', name);
    const manifest = readManifest(name);
    const target = join(appRoot, 'node_modules', manifest.name);

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
