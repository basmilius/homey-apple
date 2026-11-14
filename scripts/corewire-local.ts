import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Until @corewire is on npm: copies the built packages of a local apple-protocols checkout into
// node_modules. Real copies, no symlinks, because `homey app build` packs node_modules as is.
const PACKAGES = ['core', 'airplay', 'companion-link', 'devices', 'audio-source'];
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

const appRoot = resolve(import.meta.dir, '..');
const libraryRoot = resolve(appRoot, process.argv[2] ?? process.env.COREWIRE_PATH ?? '../../@basmilius/apple-protocols');

type Manifest = Record<string, unknown> & {
    readonly name: string;
    readonly version: string;
};

function readManifest(name: string): Manifest {
    return JSON.parse(readFileSync(join(libraryRoot, 'packages', name, 'package.json'), 'utf8'));
}

const versions = new Map(PACKAGES.map(name => {
    const manifest = readManifest(name);

    return [manifest.name, manifest.version];
}));

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

            const version = versions.get(dependency);

            if (!version) {
                console.error(`${manifest.name} depends on ${dependency} from the workspace, which this script does not copy.`);
                process.exit(1);
            }

            dependencies[dependency] = version;
            rewritten++;
        }
    }

    rmSync(target, {recursive: true, force: true});
    mkdirSync(target, {recursive: true});
    writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 4)}\n`);
    cpSync(join(source, 'dist'), join(target, 'dist'), {recursive: true, dereference: true});

    if (existsSync(join(source, 'LICENSE'))) {
        cpSync(join(source, 'LICENSE'), join(target, 'LICENSE'));
    }

    console.log(`${manifest.name}@${manifest.version}: copied dist, rewrote ${rewritten} workspace dependencies.`);
}
