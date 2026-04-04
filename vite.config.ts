/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/* eslint-disable import/no-extraneous-dependencies */

import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import legacy from '@vitejs/plugin-legacy';
import { VitePWA } from 'vite-plugin-pwa';
import { lingui } from '@lingui/vite-plugin';
import 'dotenv/config';
import { d } from 'koration';

// eslint-disable-next-line import/no-default-export
export default defineConfig(({ command }) => ({
    base: command === 'serve' ? process.env.VITE_SUBPATH || './' : './',
    build: {
        outDir: 'build',
        // Use terser for better minification (~5-10% smaller than esbuild default)
        minify: 'terser',
        terserOptions: {
            compress: {
                // Two compression passes for better size reduction
                passes: 2,
                drop_debugger: true,
            },
        },
        rollupOptions: {
            output: {
                // Split vendor dependencies into stable chunks for better browser caching
                // and to reduce the JS that must be parsed on initial page load (important for Kindle Scribe)
                manualChunks: (id) => {
                    if (!id.includes('node_modules')) return undefined;
                    if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
                        return 'vendor-react';
                    }
                    if (id.includes('/@mui/') || id.includes('/@emotion/') || id.includes('/stylis/')) {
                        return 'vendor-mui';
                    }
                    if (
                        id.includes('/apollo') ||
                        id.includes('/@apollo/') ||
                        id.includes('/graphql/') ||
                        id.includes('/@wry/') ||
                        id.includes('/zen-observable') ||
                        id.includes('/ts-invariant')
                    ) {
                        return 'vendor-graphql';
                    }
                    if (id.includes('/react-router') || id.includes('/@remix-run/')) {
                        return 'vendor-router';
                    }
                    if (
                        id.includes('/node-vibrant') ||
                        id.includes('/@vibrant/') ||
                        id.includes('/fast-average-color')
                    ) {
                        return 'vendor-image-processing';
                    }
                    if (id.includes('/@dnd-kit/')) {
                        return 'vendor-dnd';
                    }
                    if (id.includes('/dayjs/') || id.includes('/@mui/x-date-pickers/')) {
                        return 'vendor-datetime';
                    }
                    return undefined;
                },
            },
        },
    },
    server: {
        port: Number(process.env.PORT),
        allowedHosts: process.env.ALLOWED_HOSTS.split(',').map((s) => s.trim()),
    },
    resolve: {
        alias: {
            '@': path.resolve(import.meta.dirname, './src'),
        },
    },
    optimizeDeps: {
        include: ['@mui/material/Tooltip'],
    },
    plugins: [
        react({
            plugins: [['@lingui/swc-plugin', {}]],
        }),
        lingui(),
        viteTsconfigPaths(),
        legacy({
            modernPolyfills: [
                'es/array/to-spliced',
                'es/array/to-sorted',
                'es/array/find-last',
                'es/array/find-last-index',
                'es/object/group-by',
            ],
        }),
        // Only setup image runtime caching
        VitePWA({
            registerType: 'autoUpdate',
            manifest: false, // Use existing manifest
            devOptions: {
                enabled: true,
            },
            workbox: {
                globPatterns: [],
                runtimeCaching: [
                    {
                        urlPattern: ({ url }) => {
                            const { pathname } = url;
                            return pathname.match(/\/chapter\/[0-9]+\/page\/[0-9]+/g);
                        },
                        handler: 'CacheFirst',
                        options: {
                            // !!! IMPORTANT !!! - Update along with ImageCache.ts
                            cacheName: 'image-cache-chapter-pages',
                            expiration: {
                                // Max age from server
                                maxAgeSeconds: d(1).days.inWholeSeconds,
                                maxEntries: 2500,
                                purgeOnQuotaError: true,
                            },
                            cacheableResponse: {
                                statuses: [0, 200],
                            },
                        },
                    },
                    {
                        urlPattern: ({ url }) => {
                            const { pathname } = url;
                            return pathname.match(/\/manga\/[0-9]+\/thumbnail/g);
                        },
                        handler: 'CacheFirst',
                        options: {
                            // !!! IMPORTANT !!! - Update along with ImageCache.ts
                            cacheName: 'image-cache-manga-thumbnails',
                            expiration: {
                                // Max age from server
                                maxAgeSeconds: d(1).days.inWholeSeconds,
                                maxEntries: 5000,
                                purgeOnQuotaError: true,
                            },
                            cacheableResponse: {
                                statuses: [0, 200],
                            },
                        },
                    },
                    {
                        urlPattern: ({ url }) => {
                            const { pathname } = url;
                            return pathname.includes('/extension/icon/');
                        },
                        handler: 'CacheFirst',
                        options: {
                            // !!! IMPORTANT !!! - Update along with ImageCache.ts
                            cacheName: 'image-cache-extension-icons',
                            expiration: {
                                // Max age from server
                                maxAgeSeconds: d(365).days.inWholeSeconds,
                                maxEntries: 300,
                                purgeOnQuotaError: true,
                            },
                            cacheableResponse: {
                                statuses: [0, 200],
                            },
                        },
                    },
                    {
                        urlPattern: ({ request }) => request.destination === 'image',
                        handler: 'CacheFirst',
                        options: {
                            // !!! IMPORTANT !!! - Update along with ImageCache.ts
                            cacheName: 'image-cache-other',
                            expiration: {
                                maxAgeSeconds: d(4).days.inWholeSeconds,
                                maxEntries: 500,
                                purgeOnQuotaError: true,
                            },
                            cacheableResponse: {
                                statuses: [0, 200],
                            },
                        },
                    },
                ],
            },
        }),
    ],
}));
