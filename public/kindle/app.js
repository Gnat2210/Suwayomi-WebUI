/*
 * Suwayomi Kindle Companion — app.js
 *
 * A self-contained ES5 + XHR front-end for the Suwayomi server.
 * It talks to exactly the same /api/graphql endpoint as the main
 * React app, so library, read-status, downloads and bookmarks are
 * fully shared between the two UIs with no conflicts.
 *
 * Compatibility targets
 *   - ES5 strict mode (no const/let, no arrow functions, no template
 *     literals, no destructuring, no spread, no Promises, no class).
 *   - XMLHttpRequest only (no fetch).
 *   - localStorage with silent try/catch fall-through.
 *   - Hash-based routing (#library, #manga/id, #reader/mangaId/so,
 *     #downloads, #login) — mirrors the main app's URL structure.
 *
 * Screens
 *   Login       → #login
 *   Library     → #library  or  #library/<categoryId>
 *   Manga       → #manga/<id>
 *   Reader      → #reader/<mangaId>/<sourceOrder>
 *   Downloads   → #downloads
 */

(function (window, document) {
    'use strict';

    /* ================================================================
       CONFIGURATION
       ================================================================ */

    var API_URL   = '/api/graphql';
    var LS_ACCESS  = 'sw_k_access';
    var LS_REFRESH = 'sw_k_refresh';

    /* ================================================================
       APPLICATION STATE
       ================================================================ */

    var S = {
        token:        null,   // current access token (or null)
        refreshToken: null,   // current refresh token (or null)

        // Reader state — populated when entering #reader/…
        pages:       [],      // array of page-URL strings
        pageIdx:     0,       // zero-based index of displayed page
        chapterId:   0,       // GraphQL id of the current chapter
        mangaId:     0,       // GraphQL id of the current manga
        sourceOrder: 0,       // sourceOrder of the current chapter
        chapters:    [],      // all chapters for this manga (for prev/next)

        pollTimer: null       // setTimeout handle for download polling
    };

    /* ================================================================
       GRAPHQL QUERY STRINGS
       All queries are plain strings sent as JSON bodies to /api/graphql.
       Using short variable names ($u, $p, …) keeps the inline strings
       readable without needing a build step.
       ================================================================ */

    var Q = {
        // Auth
        LOGIN:
            'mutation($u:String!,$p:String!)' +
            '{login(input:{username:$u,password:$p})' +
            '{accessToken refreshToken}}',

        REFRESH:
            'mutation($t:String!)' +
            '{refreshToken(input:{refreshToken:$t})' +
            '{accessToken}}',

        // Library
        CATEGORIES:
            'query{categories(order:[{by:ORDER,byType:ASC}])' +
            '{nodes{id name default}}}',

        LIBRARY:
            'query($n:Int,$a:Cursor)' +
            '{mangas(condition:{inLibrary:true},' +
            'order:[{by:TITLE,byType:ASC}],' +
            'first:$n,after:$a)' +
            '{nodes{id title thumbnailUrl unreadCount downloadCount}' +
            'totalCount pageInfo{hasNextPage endCursor}}}',

        CAT_MANGAS:
            'query($id:Int!)' +
            '{category(id:$id)' +
            '{mangas{nodes{id title thumbnailUrl unreadCount downloadCount}' +
            'totalCount}}}',

        // Manga detail
        MANGA:
            'query($id:Int!)' +
            '{manga(id:$id)' +
            '{id title thumbnailUrl status description genre author artist}}',

        CHAPTERS:
            /* Cap at 1000 chapters — covers every manga in practice while
               keeping the XHR payload manageable on slow e-ink browsers. */
            'query($m:Int!,$n:Int)' +
            '{chapters(condition:{mangaId:$m},' +
            'order:[{by:SOURCE_ORDER,byType:ASC}],first:$n)' +
            '{nodes{id name sourceOrder isRead isDownloaded isBookmarked' +
            ' pageCount lastPageRead uploadDate}' +
            'totalCount}}',

        // Reader
        FETCH_PAGES:
            'mutation($id:Int!)' +
            '{fetchChapterPages(input:{chapterId:$id})' +
            '{chapter{id pageCount}pages}}',

        UPDATE_CHAPTERS:
            'mutation($input:UpdateChaptersInput!)' +
            '{updateChapters(input:$input)' +
            '{chapters{id isRead lastPageRead manga{id unreadCount}}}}',

        // Downloads
        DL_STATUS:
            'query{downloadStatus{state' +
            ' queue{chapter{id name sourceOrder}' +
            'manga{id title}progress state tries}}}',

        ENQUEUE:
            'mutation($id:Int!)' +
            '{enqueueChapterDownload(input:{id:$id})' +
            '{downloadStatus{state}}}',

        START_DL: 'mutation{startDownloader{status}}',
        STOP_DL:  'mutation{stopDownloader{status}}'
    };

    /* ================================================================
       STORAGE HELPERS  (silent fail when localStorage is unavailable)
       ================================================================ */

    function lsGet(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }
    function lsSet(key, val) {
        try { localStorage.setItem(key, val); } catch (e) { /* noop */ }
    }
    function lsDel(key) {
        try { localStorage.removeItem(key); } catch (e) { /* noop */ }
    }

    function loadTokens() {
        S.token        = lsGet(LS_ACCESS)  || null;
        S.refreshToken = lsGet(LS_REFRESH) || null;
    }
    function saveTokens(access, refresh) {
        S.token = access;
        lsSet(LS_ACCESS, access);
        if (refresh) {
            S.refreshToken = refresh;
            lsSet(LS_REFRESH, refresh);
        }
    }
    function clearTokens() {
        S.token = S.refreshToken = null;
        lsDel(LS_ACCESS);
        lsDel(LS_REFRESH);
    }

    /* ================================================================
       XHR / GRAPHQL LAYER
       ================================================================ */

    /**
     * Send a GraphQL request.
     *
     * @param {string}   query   GraphQL query / mutation string
     * @param {Object}   vars    Variables object (may be {})
     * @param {Function} ok      Called with response.data on success
     * @param {Function} fail    Called with error message string on failure
     */
    function gql(query, vars, ok, fail) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', API_URL, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (S.token) {
            xhr.setRequestHeader('Authorization', 'Bearer ' + S.token);
        }

        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }

            // HTTP 401 → try token refresh, then retry
            if (xhr.status === 401) {
                doRefresh(
                    function () { gql(query, vars, ok, fail); },
                    function () { clearTokens(); navigate('login'); }
                );
                return;
            }

            if (xhr.status < 200 || xhr.status >= 300) {
                if (fail) { fail('HTTP ' + xhr.status); }
                return;
            }

            var resp;
            try { resp = JSON.parse(xhr.responseText); }
            catch (e) { if (fail) { fail('Invalid server response'); } return; }

            // GraphQL-level auth errors (server returns 200 with error body)
            if (resp.errors && resp.errors.length) {
                var msg    = resp.errors[0].message || 'GraphQL error';
                var isAuth = /unauthori|unauthent|not logged|login required/i.test(msg);
                if (isAuth) {
                    doRefresh(
                        function () { gql(query, vars, ok, fail); },
                        function () { clearTokens(); navigate('login'); }
                    );
                    return;
                }
                if (fail) { fail(msg); }
                return;
            }

            if (ok) { ok(resp.data || {}); }
        };

        xhr.send(JSON.stringify({ query: query, variables: vars || {} }));
    }

    /** Attempt a token refresh; calls onSuccess or onFail when done. */
    function doRefresh(onSuccess, onFail) {
        if (!S.refreshToken) { onFail(); return; }

        var xhr = new XMLHttpRequest();
        xhr.open('POST', API_URL, true);
        xhr.setRequestHeader('Content-Type', 'application/json');

        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            var resp;
            try { resp = JSON.parse(xhr.responseText); } catch (e) { onFail(); return; }
            var newToken = resp && resp.data && resp.data.refreshToken && resp.data.refreshToken.accessToken;
            if (!newToken) { onFail(); return; }
            saveTokens(newToken, null);
            onSuccess();
        };

        xhr.send(JSON.stringify({ query: Q.REFRESH, variables: { t: S.refreshToken } }));
    }

    /* ================================================================
       DOM HELPERS
       ================================================================ */

    function byId(id) { return document.getElementById(id); }

    /** Replace the entire #app content, and cancel any pending polls. */
    function setApp(html) {
        stopPoll();
        byId('app').innerHTML = html;
    }

    /** HTML-escape a value for safe insertion via innerHTML. */
    function esc(s) {
        if (s == null) { return ''; }
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function stopPoll() {
        if (S.pollTimer) { clearTimeout(S.pollTimer); S.pollTimer = null; }
    }

    /* ================================================================
       ROUTING  (hash-based, mirrors main-app URL structure)

       Main app  →  Kindle companion
       /library  →  #library
       /manga/X  →  #manga/X
       /manga/X/chapter/N  →  #reader/X/N   (N = sourceOrder)
       /downloads  →  #downloads
       ================================================================ */

    function getHash() {
        return (window.location.hash || '#library').replace(/^#\/?/, '');
    }
    function navigate(hash) { window.location.hash = '#' + hash; }

    function route() {
        var hash  = getHash();
        var parts = hash.split('/');
        var view  = parts[0];

        if (view === 'login')     { renderLogin();                          return; }
        if (view === 'manga')     { renderManga(parts[1] | 0);              return; }
        if (view === 'reader')    { renderReader(parts[1] | 0, parts[2] | 0); return; }
        if (view === 'downloads') { renderDownloads();                      return; }
        /* default: library, optionally filtered by category */
        renderLibrary(parts[1] || '');
    }

    /* ================================================================
       NAVIGATION BAR
       ================================================================ */

    function navBar(active) {
        return '<div class="nav"><table><tr>' +
            '<td><a href="#library" class="nav-tab' + (active === 'library'   ? ' active' : '') + '">Library</a></td>' +
            '<td><a href="#downloads" class="nav-tab' + (active === 'downloads' ? ' active' : '') + '">Downloads</a></td>' +
            '</tr></table></div>';
    }

    /* ================================================================
       LOGIN VIEW
       ================================================================ */

    function renderLogin() {
        setApp(
            '<div class="screen">' +
            '<div class="login-box">' +
            '<h1>Suwayomi</h1>' +
            '<p class="sub">Kindle Edition</p>' +
            '<div id="auth-err" class="msg-err" style="display:none"></div>' +
            '<form id="lf">' +
            '<label>Username<input type="text" id="un" autocomplete="username"></label>' +
            '<label>Password<input type="password" id="pw" autocomplete="current-password"></label>' +
            '<button type="submit" class="btn btn-full btn-primary">Sign In</button>' +
            '</form>' +
            '<p class="note">No auth configured? <a href="#" id="skip-auth">Skip to library</a></p>' +
            '</div></div>'
        );

        byId('lf').onsubmit = function (e) {
            e.preventDefault();
            var errEl = byId('auth-err');
            errEl.style.display = 'none';
            gql(
                Q.LOGIN,
                { u: byId('un').value.trim(), p: byId('pw').value },
                function (d) {
                    if (!d || !d.login) { showMsgErr(errEl, 'Login failed.'); return; }
                    saveTokens(d.login.accessToken, d.login.refreshToken);
                    navigate('library');
                },
                function (err) { showMsgErr(errEl, err || 'Login failed.'); }
            );
        };

        byId('skip-auth').onclick = function (e) {
            e.preventDefault();
            navigate('library');
        };
    }

    function showMsgErr(el, msg) {
        el.innerHTML    = esc(msg);
        el.style.display = 'block';
    }

    /* ================================================================
       LIBRARY VIEW
       ================================================================ */

    function renderLibrary(catParam) {
        setApp(
            navBar('library') +
            '<div class="screen" id="lib">' +
            '<div class="loading">Loading library…</div>' +
            '</div>'
        );

        gql(Q.CATEGORIES, {},
            function (d) {
                var cats = (d.categories && d.categories.nodes) || [];
                buildLibraryShell(cats, catParam);
            },
            function () {
                /* categories failed — render without selector */
                buildLibraryShell([], catParam);
            }
        );
    }

    function buildLibraryShell(cats, catParam) {
        var lib = byId('lib');
        if (!lib) { return; }

        var html = '';
        if (cats.length > 0) {
            html += '<div class="cat-wrap"><select id="cat-sel" class="cat-sel">';
            html += '<option value="">All</option>';
            for (var i = 0; i < cats.length; i++) {
                html += '<option value="' + cats[i].id + '"' +
                    (catParam === String(cats[i].id) ? ' selected' : '') + '>' +
                    esc(cats[i].name) + '</option>';
            }
            html += '</select></div>';
        }
        html += '<div id="ml"><div class="loading">Loading manga…</div></div>';
        lib.innerHTML = html;

        var sel = byId('cat-sel');
        if (sel) {
            sel.onchange = function () {
                navigate(this.value ? 'library/' + this.value : 'library');
            };
        }

        if (catParam) {
            loadCatMangas(catParam | 0);
        } else {
            loadAllMangas();
        }
    }

    function loadAllMangas() {
        /* 300 titles fits well in a single XHR response.  Most libraries
           are smaller; the count indicator tells the user if more exist. */
        gql(Q.LIBRARY, { n: 300 },
            function (d) {
                var nodes = (d.mangas && d.mangas.nodes) || [];
                var total = (d.mangas && d.mangas.totalCount) || nodes.length;
                renderMangaGrid(nodes, total);
            },
            function (err) {
                var ml = byId('ml');
                if (ml) { ml.innerHTML = '<div class="msg-err">' + esc(err) + '</div>'; }
            }
        );
    }

    function loadCatMangas(catId) {
        gql(Q.CAT_MANGAS, { id: catId },
            function (d) {
                var nodes = (d.category && d.category.mangas && d.category.mangas.nodes) || [];
                var total = (d.category && d.category.mangas && d.category.mangas.totalCount) || nodes.length;
                renderMangaGrid(nodes, total);
            },
            function (err) {
                var ml = byId('ml');
                if (ml) { ml.innerHTML = '<div class="msg-err">' + esc(err) + '</div>'; }
            }
        );
    }

    /**
     * Render the manga list as a two-column CSS-table grid.
     * Two cards per row keeps thumbnails large enough to identify on e-ink.
     */
    function renderMangaGrid(mangas, total) {
        var ml = byId('ml');
        if (!ml) { return; }
        if (!mangas.length) { ml.innerHTML = '<div class="empty">Library is empty.</div>'; return; }

        var html = '<p class="count">' + mangas.length;
        if (total > mangas.length) { html += ' / ' + total; }
        html += ' titles</p>';

        html += '<div class="mgrid">';
        for (var i = 0; i < mangas.length; i += 2) {
            html += '<div class="mgrid-row">';
            html += mangaCard(mangas[i]);
            html += (mangas[i + 1]) ? mangaCard(mangas[i + 1]) : '<div class="mgrid-cell"></div>';
            html += '</div>';
        }
        html += '</div>';

        ml.innerHTML = html;
    }

    function mangaCard(m) {
        var thumb = m.thumbnailUrl
            ? '<img src="' + esc(m.thumbnailUrl) + '" alt="" class="mthumb">'
            : '<div class="mthumb mthumb-ph"></div>';
        var badge = (m.unreadCount > 0)
            ? '<div class="mbadge">' + m.unreadCount + ' unread</div>'
            : '';
        return '<div class="mgrid-cell">' +
            '<a href="#manga/' + m.id + '" class="mcard">' +
            thumb +
            '<div class="mtitle">' + esc(m.title) + '</div>' +
            badge +
            '</a></div>';
    }

    /* ================================================================
       MANGA DETAIL VIEW
       ================================================================ */

    function renderManga(mangaId) {
        if (!mangaId) { navigate('library'); return; }

        setApp(
            navBar('library') +
            '<div class="screen" id="mscreen">' +
            '<a href="#library" class="back">&#8592; Library</a>' +
            '<div class="loading">Loading…</div>' +
            '</div>'
        );

        /* Load manga info and chapter list in parallel */
        var mInfo = null, mChs = null;
        function tryRender() {
            if (mInfo === null || mChs === null) { return; }
            buildMangaDetail(mangaId, mInfo, mChs);
        }

        gql(Q.MANGA, { id: mangaId },
            function (d) { mInfo = (d && d.manga) || {}; tryRender(); },
            function ()   { mInfo = {};                   tryRender(); }
        );
        gql(Q.CHAPTERS, { m: mangaId, n: 1000 },
            function (d) { mChs = (d.chapters && d.chapters.nodes) || []; tryRender(); },
            function ()   { mChs = [];                                      tryRender(); }
        );
    }

    function buildMangaDetail(mangaId, info, chapters) {
        var screen = byId('mscreen');
        if (!screen) { return; }

        /* ---- header ---- */
        var html = '<a href="#library" class="back">&#8592; Library</a>';
        html += '<div class="mheader">';
        if (info.thumbnailUrl) {
            html += '<div class="mcover-wrap"><img src="' + esc(info.thumbnailUrl) + '" alt="" class="mcover"></div>';
        }
        html += '<div class="minfo">';
        html += '<h1>' + esc(info.title || ('Manga #' + mangaId)) + '</h1>';
        if (info.author) { html += '<p>Author: ' + esc(info.author) + '</p>'; }
        if (info.status) { html += '<p>Status: ' + esc(info.status) + '</p>'; }
        if (info.genre && info.genre.length) {
            html += '<p>Genres: ' + esc(info.genre.join(', ')) + '</p>';
        }
        html += '</div></div>';

        if (info.description) {
            html += '<div class="mdesc">' + esc(info.description) + '</div>';
        }

        /* ---- chapter section ---- */
        html += '<div class="ch-section">';
        html += '<div class="ch-header">';
        html += '<span class="ch-count">' + chapters.length + ' chapters</span>';

        /* "Continue" button pointing at the first unread chapter */
        var firstUnreadSO = null;
        for (var i = 0; i < chapters.length; i++) {
            if (!chapters[i].isRead) { firstUnreadSO = chapters[i].sourceOrder; break; }
        }
        if (firstUnreadSO !== null) {
            html += ' <a href="#reader/' + mangaId + '/' + firstUnreadSO + '" class="btn btn-primary">Continue</a>';
        }
        html += ' <button class="btn" id="markAllBtn">Mark All Read</button>';
        html += '</div>';

        /* ---- chapter list (newest first) ---- */
        html += '<div class="chlist">';
        var sorted = chapters.slice().reverse();
        for (var j = 0; j < sorted.length; j++) {
            var ch   = sorted[j];
            var cls  = ch.isRead ? 'chi read' : 'chi unread';
            var icons = (ch.isDownloaded ? ' &#128190;' : '') + (ch.isBookmarked ? ' &#128278;' : '');
            var dt   = ch.uploadDate ? new Date(ch.uploadDate).toLocaleDateString() : '';

            html += '<div class="' + cls + '">';
            html += '<a href="#reader/' + mangaId + '/' + ch.sourceOrder + '" class="chilink">' +
                '<span class="chiname">' + esc(ch.name) + icons + '</span>' +
                '<span class="chidate">' + esc(dt) + '</span>' +
                '</a>';
            if (!ch.isDownloaded) {
                html += '<span class="chi-dl">' +
                    '<button class="btn btn-sm dl-btn" data-cid="' + ch.id + '">DL</button>' +
                    '</span>';
            }
            html += '</div>';
        }
        html += '</div></div>';

        screen.innerHTML = html;

        /* ---- bind mark-all-read ---- */
        var markBtn = byId('markAllBtn');
        if (markBtn) {
            markBtn.onclick = function () {
                var ids = [];
                for (var k = 0; k < chapters.length; k++) {
                    if (!chapters[k].isRead) { ids.push(chapters[k].id); }
                }
                if (!ids.length) { markBtn.textContent = 'Already read'; return; }
                markBtn.disabled    = true;
                markBtn.textContent = 'Working…';
                gql(
                    Q.UPDATE_CHAPTERS,
                    { input: { ids: ids, patch: { isRead: true } } },
                    function () {
                        markBtn.textContent = 'Done!';
                        setTimeout(function () { renderManga(mangaId); }, 700);
                    },
                    function (err) {
                        markBtn.disabled    = false;
                        markBtn.textContent = 'Error';
                        alert('Could not mark chapters: ' + err);
                    }
                );
            };
        }

        /* ---- bind per-chapter download buttons ---- */
        var dlBtns = document.querySelectorAll('.dl-btn');
        for (var d = 0; d < dlBtns.length; d++) {
            (function (btn) {
                btn.onclick = function () {
                    btn.disabled    = true;
                    btn.textContent = '…';
                    var cid = parseInt(btn.getAttribute('data-cid'), 10);
                    gql(
                        Q.ENQUEUE, { id: cid },
                        function () { btn.textContent = '✓'; },
                        function () { btn.disabled = false; btn.textContent = 'DL'; }
                    );
                };
            })(dlBtns[d]);
        }
    }

    /* ================================================================
       READER VIEW
       ================================================================ */

    function renderReader(mangaId, sourceOrder) {
        if (!mangaId || sourceOrder === undefined) { navigate('library'); return; }

        S.mangaId     = mangaId;
        S.sourceOrder = sourceOrder;
        S.pages       = [];
        S.pageIdx     = 0;
        S.chapters    = [];
        S.chapterId   = 0;

        setApp(
            '<div class="reader-wrap" id="rw">' +
            '<div class="r-top">' +
            '<a href="#manga/' + mangaId + '" class="btn r-close">&#10005; Close</a>' +
            '<span class="r-title" id="r-title">Loading…</span>' +
            '</div>' +
            '<div class="r-body" id="r-body">' +
            '<div class="loading" style="color:#cccccc">Loading chapter…</div>' +
            '</div>' +
            '<div class="r-bot" id="r-bot"></div>' +
            '</div>'
        );

        /* Fetch all chapters first (needed for prev/next chapter navigation) */
        gql(Q.CHAPTERS, { m: mangaId, n: 1000 },
            function (d) {
                S.chapters = (d.chapters && d.chapters.nodes) || [];

                /* Find the requested chapter by sourceOrder */
                var chapter = null;
                for (var i = 0; i < S.chapters.length; i++) {
                    if (S.chapters[i].sourceOrder === sourceOrder) { chapter = S.chapters[i]; break; }
                }
                if (!chapter) {
                    var rb = byId('r-body');
                    if (rb) {
                        rb.innerHTML = '<div class="msg-err">Chapter not found. ' +
                            '<a href="#manga/' + mangaId + '" style="color:#fff">Back</a></div>';
                    }
                    return;
                }

                S.chapterId = chapter.id;
                var titleEl = byId('r-title');
                if (titleEl) { titleEl.textContent = chapter.name; }

                /* Fetch page URLs from server */
                gql(Q.FETCH_PAGES, { id: chapter.id },
                    function (pd) {
                        var pages = (pd.fetchChapterPages && pd.fetchChapterPages.pages) || [];
                        if (!pages.length) {
                            var rb2 = byId('r-body');
                            if (rb2) { rb2.innerHTML = '<div class="msg-err">No pages found.</div>'; }
                            return;
                        }
                        S.pages = pages;

                        /* Restore last reading position (skip if it's the final page) */
                        var startPage = 0;
                        if (chapter.lastPageRead > 0 && chapter.lastPageRead < pages.length - 1) {
                            startPage = chapter.lastPageRead;
                        }

                        buildReaderUI(mangaId, sourceOrder);
                        showPage(startPage);
                    },
                    function (err) {
                        var rb3 = byId('r-body');
                        if (rb3) { rb3.innerHTML = '<div class="msg-err">Error fetching pages: ' + esc(err) + '</div>'; }
                    }
                );
            },
            function (err) {
                var rb4 = byId('r-body');
                if (rb4) { rb4.innerHTML = '<div class="msg-err">Error loading chapters: ' + esc(err) + '</div>'; }
            }
        );
    }

    function buildReaderUI(mangaId, sourceOrder) {
        var rbot = byId('r-bot');
        if (!rbot) { return; }

        /* Find prev / next chapter sourceOrders */
        var prevSO = null, nextSO = null;
        for (var i = 0; i < S.chapters.length; i++) {
            if (S.chapters[i].sourceOrder === sourceOrder) {
                if (i > 0)                     { prevSO = S.chapters[i - 1].sourceOrder; }
                if (i < S.chapters.length - 1) { nextSO = S.chapters[i + 1].sourceOrder; }
                break;
            }
        }

        /* Replace the r-body with the page container */
        var rbody = byId('r-body');
        if (rbody) { rbody.innerHTML = '<div id="r-page-wrap"></div>'; }

        /* Build the bottom bar */
        var prevCh = prevSO !== null
            ? '<a href="#reader/' + mangaId + '/' + prevSO + '" class="btn r-ch-btn">&#8592; Prev Ch</a>'
            : '<span class="btn r-ch-btn disabled">&#8592; Prev Ch</span>';
        var nextCh = nextSO !== null
            ? '<a href="#reader/' + mangaId + '/' + nextSO + '" class="btn r-ch-btn">Next Ch &#8594;</a>'
            : '<span class="btn r-ch-btn disabled">Next Ch &#8594;</span>';

        rbot.innerHTML =
            '<div class="r-page-controls">' +
            '<button class="r-page-btn" id="prev-pg">&#8592; Prev</button>' +
            '<span class="r-indicator" id="r-ind"></span>' +
            '<button class="r-page-btn" id="next-pg">Next &#8594;</button>' +
            '</div>' +
            '<div class="r-ch-nav">' + prevCh + ' ' + nextCh + '</div>';

        byId('prev-pg').onclick = prevPage;
        byId('next-pg').onclick = nextPage;

        /* Keyboard navigation (physical page-turn buttons on Kindle) */
        document.onkeydown = function (e) {
            var key = e.keyCode || e.which;
            if (key === 37 || key === 33) { prevPage(); } /* Left arrow / Page Up */
            if (key === 39 || key === 34) { nextPage(); } /* Right arrow / Page Down */
        };
    }

    function showPage(idx) {
        if (idx < 0)             { idx = 0; }
        if (idx >= S.pages.length) { idx = S.pages.length - 1; }
        S.pageIdx = idx;

        var wrap = byId('r-page-wrap');
        if (wrap) {
            wrap.innerHTML =
                '<img src="' + esc(S.pages[idx]) + '" alt="Page ' + (idx + 1) + '" ' +
                'class="r-page-img" id="r-img" ' +
                'onerror="this.alt=\'Failed to load page ' + (idx + 1) + '\'">';
        }

        var ind = byId('r-ind');
        if (ind) { ind.innerHTML = (idx + 1) + ' / ' + S.pages.length; }

        var prevBtn = byId('prev-pg');
        var nextBtn = byId('next-pg');
        if (prevBtn) { prevBtn.disabled = (idx === 0); }
        if (nextBtn) { nextBtn.disabled = (idx === S.pages.length - 1); }

        /* Persist progress; mark as read when the last page is reached */
        var patch = { lastPageRead: idx };
        if (idx === S.pages.length - 1) { patch.isRead = true; }
        gql(Q.UPDATE_CHAPTERS, { input: { ids: [S.chapterId], patch: patch } },
            function () { /* noop — background save */ },
            function () { /* noop — non-critical */ }
        );
    }

    function prevPage() { if (S.pageIdx > 0)                  { showPage(S.pageIdx - 1); } }
    function nextPage() { if (S.pageIdx < S.pages.length - 1) { showPage(S.pageIdx + 1); } }

    /* ================================================================
       DOWNLOADS VIEW
       ================================================================ */

    function renderDownloads() {
        setApp(
            navBar('downloads') +
            '<div class="screen" id="dl-screen">' +
            '<h2 style="margin-bottom:14px;font-family:Arial,Helvetica,sans-serif">Downloads</h2>' +
            '<div id="dl-ctrl"></div>' +
            '<div id="dl-list"><div class="loading">Loading…</div></div>' +
            '</div>'
        );
        pollDownloads();
    }

    function pollDownloads() {
        gql(Q.DL_STATUS, {},
            function (d) {
                var status = d && d.downloadStatus;
                renderDownloadStatus(status);
                /* Only continue polling while this screen is still visible
                   AND there is active work (running or non-empty queue).
                   Stop immediately when the downloader is idle and the
                   queue is empty to avoid unnecessary battery drain. */
                var isActive = status &&
                    (status.state === 'STARTED' ||
                     (status.queue && status.queue.length > 0));
                if (isActive && byId('dl-screen')) {
                    S.pollTimer = setTimeout(function () {
                        if (byId('dl-screen')) { pollDownloads(); }
                    }, 5000);
                }
            },
            function (err) {
                var dl = byId('dl-list');
                if (dl) { dl.innerHTML = '<div class="msg-err">' + esc(err) + '</div>'; }
            }
        );
    }

    function renderDownloadStatus(status) {
        var ctrlEl = byId('dl-ctrl');
        var listEl = byId('dl-list');
        if (!ctrlEl || !listEl) { return; }

        var state = (status && status.state) || 'STOPPED';
        var queue = (status && status.queue) || [];

        /* Controls row: running indicator + start/stop button */
        ctrlEl.innerHTML = state === 'STARTED'
            ? '<span class="dl-state">&#9679; Running</span>' +
              '<button class="btn" id="stop-dl-btn">&#9646;&#9646; Stop</button>'
            : '<span class="dl-state">&#9675; Stopped</span>' +
              '<button class="btn btn-primary" id="start-dl-btn">&#9654; Start</button>';

        var startBtn = byId('start-dl-btn');
        var stopBtn  = byId('stop-dl-btn');
        if (startBtn) {
            startBtn.onclick = function () {
                startBtn.disabled = true;
                gql(Q.START_DL, {}, function () { pollDownloads(); }, function (err) {
                    startBtn.disabled = false;
                    alert('Error: ' + err);
                });
            };
        }
        if (stopBtn) {
            stopBtn.onclick = function () {
                stopBtn.disabled = true;
                gql(Q.STOP_DL, {}, function () { pollDownloads(); }, function (err) {
                    stopBtn.disabled = false;
                    alert('Error: ' + err);
                });
            };
        }

        /* Queue list */
        if (!queue.length) {
            listEl.innerHTML = '<div class="empty">Queue is empty.</div>';
            return;
        }

        var html = '<p class="count">' + queue.length + ' item(s)</p><div class="dl-list">';
        for (var i = 0; i < queue.length; i++) {
            var item  = queue[i];
            var pct   = item.progress ? Math.round(item.progress * 100) : 0;
            var dlState = item.state ? esc(item.state) : '';
            html += '<div class="dl-item">' +
                '<div class="dl-manga">' + esc(item.manga ? item.manga.title : '—') + '</div>' +
                '<div class="dl-chapter">' + esc(item.chapter ? item.chapter.name : '—') + '</div>' +
                '<div class="dl-prog-bar"><div class="dl-prog-fill" style="width:' + pct + '%"></div></div>' +
                '<div class="dl-prog-label">' + pct + '%' + (dlState ? ' &mdash; ' + dlState : '') + '</div>' +
                '</div>';
        }
        html += '</div>';
        listEl.innerHTML = html;
    }

    /* ================================================================
       INITIALISATION
       ================================================================ */

    function init() {
        loadTokens();

        window.addEventListener('hashchange', function () {
            /* Remove reader keyboard handler when leaving the reader */
            document.onkeydown = null;
            stopPoll();
            route();
        });

        route();
    }

    /* Start after DOM is ready */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})(window, document);
