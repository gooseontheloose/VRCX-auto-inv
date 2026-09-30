import { resolve } from 'node:path';

import fs from 'node:fs';

import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite';
import { browserslistToTargets } from 'lightningcss';

import browserslist from 'browserslist';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';

import { languageCodes } from './localization/locales';

/**
 * Vite plugin to remove legacy remixicon font files (eot, woff, ttf, svg)
 * from the build output, keeping only woff2. Saves ~4.5 MB.
 *
 * Chrome 144 picks woff2 from the multi-format @font-face src list and
 * never requests the other formats, so deleting them is safe.
 *
 * @returns {import('vite').Plugin}
 */
function remixiconWoff2Only() {
    return {
        name: 'remixicon-woff2-only',
        generateBundle(_, bundle) {
            for (const key of Object.keys(bundle)) {
                if (/remixicon\.(eot|ttf|svg|woff)$/.test(key)) {
                    delete bundle[key];
                }
            }
        }
    };
}

/**
 * Picks the module behind the `@paw/telemetry` alias.
 *
 * Official builds include the private telemetry module: a checkout of the private
 * paw-telemetry repo in ./telemetry-private (`npm run telemetry:link`) or at PAW_TELEMETRY_DIR.
 * Without it the app is built with src/services/telemetryStub.js, which sends nothing, and the
 * settings switch and notice are compiled out (`__PAW_TELEMETRY__` is false).
 * PAW_TELEMETRY_REQUIRED=1 (release CI) makes a missing module a build error.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ real: boolean; entry: string; dir: string }}
 */
function resolveTelemetryModule(env) {
    const dir = env.PAW_TELEMETRY_DIR
        ? resolve(env.PAW_TELEMETRY_DIR)
        : resolve(import.meta.dirname, '../telemetry-private');
    const realEntry = resolve(dir, 'client/index.js');
    const real = fs.existsSync(realEntry);
    if (!real && env.PAW_TELEMETRY_REQUIRED === '1') {
        throw new Error(
            `PAW_TELEMETRY_REQUIRED=1 but the telemetry module was not found at ${realEntry}. ` +
                'Run "npm run telemetry:link" or set PAW_TELEMETRY_DIR.'
        );
    }
    if (real && env.PAW_TELEMETRY_REQUIRED === '1') {
        // A release must not ship with the module's placeholder endpoint (an undeployed domain
        // someone else could claim). The private repo marks it with TODO(deploy).
        const constants = resolve(dir, 'client/constants.js');
        if (fs.existsSync(constants) && fs.readFileSync(constants, 'utf8').includes('TODO(deploy)')) {
            throw new Error(
                `The telemetry endpoint in ${constants} is still a placeholder (TODO(deploy)). ` +
                    'Deploy the server and set the real URL in the paw-telemetry repo first.'
            );
        }
    }
    return {
        real,
        entry: real ? realEntry : resolve(import.meta.dirname, 'services/telemetryStub.js'),
        dir
    };
}

/**
 * @param assetId
 */
function getAssetLanguage(assetId) {
    if (!assetId) return null;

    if (assetId.endsWith('.json')) {
        const language = assetId.split('.json')[0];

        if (languageCodes.includes(language)) return language;
    }

    const language =
        // Font assets, e.g., noto-sans-jp-regular.woff2 mapped to language code.
        {
            jp: 'ja',
            sc: 'zh-CN',
            tc: 'zh-TW',
            kr: 'ko'
        }[assetId.split('noto-sans-')[1]?.split('-')[0]];

    return language || null;
}

/**
 * @param moduleId
 */
function getManualChunk(moduleId) {
    const basename = moduleId.split('/').pop();
    const language = getAssetLanguage(basename);
    if (!language) return;

    return `i18n/${language}`;
}

const defaultAssetName = '[name][extname]';

/**
 * @param {string} name
 */
function isFont(name) {
    return /\.(woff2?|ttf|otf|eot)$/.test(name);
}

/**
 * @param {import('rolldown').PreRenderedAsset} assetInfo
 */
function getAssetFilename({ name }) {
    const language = getAssetLanguage(name);
    if (!language) return `assets/${defaultAssetName}`;

    if (isFont(name)) return 'assets/fonts/[name][extname]';
    return 'assets/i18n/[name][extname]';
}

/**
 * @param ConfigEnv ConfigEnv
 * @returns {import('vite').UserConfig}
 */
export default defineConfig(({ mode }) => {
    const { SENTRY_AUTH_TOKEN: sentryAuthToken } = loadEnv(mode, process.cwd(), '');

    const buildAndUploadSourceMaps = !!sentryAuthToken;

    const version = fs.readFileSync(new URL('../Version', import.meta.url), 'utf-8').trim();

    const nightly = mode === 'development' || version.split('-').at(-1).length === 7;

    const telemetry = resolveTelemetryModule({ ...loadEnv(mode, process.cwd(), 'PAW_'), ...process.env });
    console.log(`[telemetry] ${telemetry.real ? 'telemetry module included' : 'no-op stub (no telemetry)'}`);

    /** @type {import('vite').UserConfig} */
    return {
        base: '',
        plugins: [
            remixiconWoff2Only(),
            vue(),
            vueJsx({
                tsTransform: 'built-in'
            }),
            tailwindcss(),
            buildAndUploadSourceMaps &&
                import('@sentry/vite-plugin').then(({ sentryVitePlugin }) =>
                    sentryVitePlugin({
                        authToken: sentryAuthToken,
                        project: 'vrcx-web',
                        release: {
                            name: version
                        },
                        sourcemaps: {
                            assets: './build/html/**',
                            filesToDeleteAfterUpload: './build/html/**/*.js.map',
                            ignore: []
                        }
                    })
                )
        ],
        resolve: {
            alias: [
                { find: /^@paw\/telemetry$/, replacement: telemetry.entry },
                { find: '@', replacement: resolve(import.meta.dirname, '.') }
            ]
        },
        css: {
            transformer: 'lightningcss',
            lightningcss: {
                drafts: {
                    customMedia: true
                },
                errorRecovery: true,
                targets: browserslistToTargets(browserslist('Chrome 145'))
            }
        },
        optimizeDeps: {
            include: [
                'vue',
                'vue/jsx-runtime',
                'reka-ui',
                'pinia',
                'vue-i18n',
                'tailwindcss',
                'lucide-vue-next',
                '@vueuse/core',
                'vue-sonner',
                'dayjs'
            ]
        },
        define: {
            VERSION: JSON.stringify(version),
            NIGHTLY: JSON.stringify(nightly),
            __PAW_TELEMETRY__: JSON.stringify(telemetry.real)
        },
        server: {
            port: 9000,
            strictPort: true,
            fs: {
                allow: telemetry.real
                    ? [searchForWorkspaceRoot(process.cwd()), telemetry.dir]
                    : [searchForWorkspaceRoot(process.cwd())]
            }
        },
        build: {
            target: 'chrome145',
            outDir: '../build/html',
            license: true,
            emptyOutDir: true,
            copyPublicDir: true,
            reportCompressedSize: false,
            chunkSizeWarningLimit: 5000,
            sourcemap: buildAndUploadSourceMaps ? 'hidden' : false,
            assetsInlineLimit(filePath, content) {
                if (isFont(filePath)) return false;
                if (filePath.endsWith('.json')) return false;
                return content.length <= 40960;
            },
            rolldownOptions: {
                preserveEntrySignatures: false,
                input: {
                    index: resolve(import.meta.dirname, './index.html'),
                    vr: resolve(import.meta.dirname, './vr.html')
                },
                output: {
                    assetFileNames: getAssetFilename,
                    manualChunks: getManualChunk
                }
            }
        }
    };
});
