/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ResizeObserver as JuggleResizeObserver } from '@juggle/resize-observer';

window.ResizeObserver ??= JuggleResizeObserver;

// Object.hasOwn polyfill (added in Safari 15.4 / March 2022; the Kindle Scribe's experimental browser
// is WebKit-based and may run an older WebKit version that does not include this method)
if (!('hasOwn' in Object)) {
    Object.defineProperty(Object, 'hasOwn', {
        value: (obj: object, key: PropertyKey) => {
            if (obj == null) {
                throw new TypeError('Cannot convert undefined or null to object');
            }
            return Object.prototype.hasOwnProperty.call(obj, key);
        },
        writable: true,
        configurable: true,
    });
}
