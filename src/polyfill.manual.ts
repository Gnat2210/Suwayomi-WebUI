/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ResizeObserver as JuggleResizeObserver } from '@juggle/resize-observer';

window.ResizeObserver ??= JuggleResizeObserver;

// Object.hasOwn polyfill (not available in Chrome < 93, borderline for Kindle Scribe's Silk browser)
if (!('hasOwn' in Object)) {
    Object.defineProperty(Object, 'hasOwn', {
        value: (obj: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(obj, key),
        writable: true,
        configurable: true,
    });
}
