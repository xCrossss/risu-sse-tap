// ==UserScript==
// @name         Risu SSE Tap
// @namespace    xCross
// @version      2.2.6
// @description  스트리밍 요청 모니터. PocketRisu /proxy2 대응, Responses API 파싱, 대용량 응답 렌더 최적화
// @copyright    2026, xCross
// @license      CC-BY-NC-SA-4.0
// @updateURL    https://git.skeph.net/risu-sse-tap/risu_sse_tap.user.js
// @downloadURL  https://git.skeph.net/risu-sse-tap/risu_sse_tap.user.js
// @match        https://*.ts.net/*
// @match        https://*.trycloudflare.com/*
// @match        http://localhost:6001/*
// @match        http://127.0.0.1:6001/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    var o = window.__sseTapOrigFetch || window.fetch;
    if (window.__sseTapInstalled) { return; }
    window.__sseTapInstalled = true;
    window.__sseTapOrigFetch = o;

    var R = [], S = null, P = false, ID = 0, V = 'raw';
    var MAX_VIEW = 300000; // 렌더 상한. 넘으면 뒷부분만 그린다.

    // ── URL 필터 ────────────────────────────────────────────────────────────
    var DENY = [
        /\/api\/patch(?:[/?#]|$)/,
        /\/api\/session(?:[/?#]|$)/,
        /\/api\/token(?:[/?#]|$)/,
        /\/api\/test_auth(?:[/?#]|$)/,
        /\/api\/login(?:[/?#]|$)/,
        /\/api\/set_password(?:[/?#]|$)/,
        /\/api\/asset(?:[/?#]|$)/,
        /\/api\/assets(?:[/?#]|$)/,
        /\/api\/remove(?:[/?#]|$)/,
        /\/api\/chat-content(?:[/?#]|$)/,
        /\/hub-proxy(?:[/?#]|$)/
    ];
    var ALLOW = [
        /\/proxy2(?:[/?#]|$)/,
        /\/proxy(?:[/?#]|$)/,
        /\/api\/chat(?:[/?#]|$)/,
        /\/api\/completion/,
        /\/v1\/messages/,
        /\/v1\/chat\/completions/,
        /\/v1\/responses/,
        /\/openapi\/chat\/completions/,
        /\/openapi\/responses/,
        /generativelanguage\.googleapis\.com\/v[^/]+\/models(?:\/|$)/,
        /:generateContent(?:\?|$)/,
        /:streamGenerateContent(?:\?|$)/,
        /\/streamGenerateContent(?:\?|$)/,
        /\/invoke-with-response-stream(?:\?|$)/,
        /\/converse-stream(?:\?|$)/
    ];

    // 서버 사이드 요청(model-jobs)은 폴링 호출이 섞여 있다.
    // ?active=1 / ?unclaimed=1 목록 조회와 :id 상태 조회는 몇 초마다 도니 제외하고,
    // 작업 생성(POST)과 실제 스트림(:id/stream)만 잡는다.
    function modelJobsOk(u, m) {
        if (/\/api\/model-jobs\/[^/?#]+\/stream(?:[?#]|$)/.test(u)) return true;
        if (/\/api\/model-jobs(?:[?#]|$)/.test(u)) return String(m || '').toUpperCase() === 'POST';
        return false;
    }

    function ok(u, m) {
        u = String(u || '');
        for (var i = 0; i < DENY.length; i++) { if (DENY[i].test(u)) return false; }
        if (u.indexOf('/api/model-jobs') !== -1) return modelJobsOk(u, m);
        return ALLOW.some(function (p) {
            return typeof p === 'string' ? u.indexOf(p) !== -1 : p.test(u);
        });
    }

    // PocketRisu가 /proxy2로 보낼 때 실제 목적지는 risu-url 헤더에 들어간다.
    function realTarget(url, hdrs) {
        try {
            if (!hdrs) return null;
            var v = hdrs['risu-url'];
            if (!v) return null;
            return decodeURIComponent(v);
        } catch (e) { return null; }
    }

    // ── UI ──────────────────────────────────────────────────────────────────
    var fab = document.createElement('div');
    fab.textContent = '📡';
    fab.style.cssText = 'position:fixed;top:100px;right:10px;width:44px;height:44px;background:#000;color:#0f0;border:2px solid #0f0;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;z-index:999999;cursor:move;touch-action:none;user-select:none';
    document.body.appendChild(fab);

    var bg = document.createElement('span');
    bg.style.cssText = 'position:absolute;top:-4px;right:-4px;background:#f00;color:#fff;font-size:10px;border-radius:8px;padding:1px 5px;min-width:16px;text-align:center';
    bg.textContent = '0';
    fab.appendChild(bg);

    var pn = document.createElement('div');
    pn.style.cssText = 'position:fixed;top:10px;right:10px;bottom:10px;width:90%;max-width:380px;background:#1a1a1a;color:#eee;font:11px monospace;z-index:999998;border:1px solid #0f0;display:none;flex-direction:column';

    var hd = document.createElement('div');
    hd.style.cssText = 'padding:6px 10px;background:#0f0;color:#000;display:flex;justify-content:space-between;align-items:center;font-weight:bold';
    hd.innerHTML = '<span id="_t">Requests (0)</span><span><button id="_cp" style="background:#000;color:#0f0;border:0;padding:2px 6px;margin-right:4px">Copy</button><button id="_cl" style="background:#000;color:#0f0;border:0;padding:2px 6px;margin-right:4px">Clear</button><button id="_cs" style="background:#000;color:#0f0;border:0;padding:2px 8px">×</button></span>';
    pn.appendChild(hd);

    var ls = document.createElement('div');
    ls.style.cssText = 'overflow:auto;max-height:40%;border-bottom:1px solid #333';
    pn.appendChild(ls);

    var tb = document.createElement('div');
    tb.style.cssText = 'display:flex;background:#222;border-bottom:1px solid #333';
    tb.innerHTML = '<button id="_vr" style="flex:1;background:#0f0;color:#000;border:0;padding:4px;font-weight:bold;cursor:pointer">Raw</button><button id="_vt" style="flex:1;background:#222;color:#0f0;border:0;padding:4px;cursor:pointer">Text</button>';
    pn.appendChild(tb);

    var dw = document.createElement('div');
    dw.style.cssText = 'flex:1;position:relative;display:flex;flex-direction:column;min-height:0';

    // 스크롤 컨테이너 안을 헤더/본문 두 노드로 나눈다. 청크가 들어올 때마다
    // 전체를 한 텍스트 노드에 다시 쓰면 수백 KB에서 레이아웃이 통째로 다시
    // 계산돼서 탭 전환조차 먹통이 된다.
    var dt = document.createElement('div');
    dt.style.cssText = 'flex:1;overflow:auto;background:#000;color:#0f0';
    var hdrEl = document.createElement('div');
    hdrEl.style.cssText = 'padding:8px 8px 0;white-space:pre-wrap;overflow-wrap:anywhere;color:#8f8';
    var bodyEl = document.createElement('div');
    bodyEl.style.cssText = 'padding:8px;white-space:pre-wrap;overflow-wrap:anywhere';
    var sumEl = document.createElement('div');
    sumEl.style.cssText = 'padding:0 8px 8px;color:#8f8;display:none';
    dt.appendChild(hdrEl);
    dt.appendChild(bodyEl);
    dt.appendChild(sumEl);
    hdrEl.textContent = '';
    bodyEl.textContent = 'Select a request...';
    dw.appendChild(dt);

    var jb = document.createElement('button');
    jb.textContent = '↓';
    jb.style.cssText = 'position:absolute;bottom:10px;right:10px;width:36px;height:36px;border-radius:50%;background:#0f0;color:#000;border:0;font-size:18px;font-weight:bold;cursor:pointer;display:none;box-shadow:0 2px 6px rgba(0,0,0,0.5)';
    jb.onclick = function () { dt.scrollTop = dt.scrollHeight; };
    dw.appendChild(jb);
    pn.appendChild(dw);
    document.body.appendChild(pn);

    function ts(d) { return d.toTimeString().substr(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); }
    function atB() { return dt.scrollHeight - dt.scrollTop - dt.clientHeight < 30; }
    dt.addEventListener('scroll', function () { jb.style.display = atB() ? 'none' : 'block'; });

    function setV(v) {
        V = v;
        document.getElementById('_vr').style.cssText = 'flex:1;background:' + (v === 'raw' ? '#0f0' : '#222') + ';color:' + (v === 'raw' ? '#000' : '#0f0') + ';border:0;padding:4px;font-weight:bold;cursor:pointer';
        document.getElementById('_vt').style.cssText = 'flex:1;background:' + (v === 'text' ? '#0f0' : '#222') + ';color:' + (v === 'text' ? '#000' : '#0f0') + ';border:0;padding:4px;font-weight:bold;cursor:pointer';
        rd(true);
    }
    document.getElementById('_vr').onclick = function () { setV('raw'); };
    document.getElementById('_vt').onclick = function () { setV('text'); };

    // ══════════════════════════════════════════════════════════════════════
    // PARSER-START
    // ══════════════════════════════════════════════════════════════════════
    function parseObj(s) {
        if (typeof s !== 'string') return null;
        try { return JSON.parse(s); } catch (e) { return null; }
    }

    // SSE 본문을 이벤트 객체 배열로 평탄화한다.
    function parseEvents(raw) {
        var out = [];
        function push(s) {
            if (!s) return false;
            s = String(s).trim();
            if (!s || s === '[DONE]') return false;
            var d = parseObj(s);
            if (d === null) return false;
            var stack = [d];
            while (stack.length) {
                var cur = stack.pop();
                if (Array.isArray(cur)) {
                    for (var i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
                } else if (cur && typeof cur === 'object') {
                    out.push(cur);
                }
            }
            return true;
        }
        var text = String(raw || '').replace(/\r\n/g, '\n');
        text.split(/\n\n+/).forEach(function (block) {
            var lines = [];
            block.split('\n').forEach(function (l) {
                if (l.indexOf('data:') === 0) {
                    var v = l.slice(5);
                    if (v.charAt(0) === ' ') v = v.slice(1);
                    lines.push(v);
                }
            });
            if (lines.length && !push(lines.join('\n'))) {
                lines.forEach(function (x) { push(x); });
            }
        });
        if (!out.length) {
            if (!push(text)) {
                text.split('\n').forEach(function (l) {
                    l = l.trim();
                    if (l && (l.charAt(0) === '{' || l.charAt(0) === '[')) push(l);
                });
            }
        }
        return out;
    }

    function modelFromUrl(u) {
        u = String(u || '');
        var m = u.match(/\/models\/([^/?#:]+):(?:generateContent|streamGenerateContent)(?:\?|$)/);
        if (!m) m = u.match(/\/model\/([^/]+)\/(?:invoke-with-response-stream|converse-stream)(?:\?|$)/);
        return m ? decodeURIComponent(m[1]) : '';
    }

    function reqMeta(body, u) {
        var d = typeof body === 'string' ? parseObj(body) : (body && typeof body === 'object' ? body : null);
        var m = {}, th = [], tc, v;
        v = modelFromUrl(u);
        if (v) m.model = v;
        if (d) {
            if (d.model !== undefined) m.model = d.model;
            else if (d.modelId !== undefined) m.model = d.modelId;
            else if (d.model_id !== undefined) m.model = d.model_id;
            if (d.service_tier !== undefined) m.service_tier = d.service_tier;
            else if (d.serviceTier !== undefined) m.service_tier = d.serviceTier;
            v = d.reasoning_effort;
            if (v === undefined && d.reasoning) v = d.reasoning.effort;
            if (v === undefined && d.reasoningConfig) v = d.reasoningConfig.effort;
            if (v !== undefined) m.reasoning_effort = v;
            if (d.reasoning && d.reasoning.summary !== undefined) m.reasoning_summary = d.reasoning.summary;
            if (d.text && d.text.verbosity !== undefined) m.verbosity = d.text.verbosity;
            if (d.thinking) {
                if (d.thinking.type !== undefined) th.push('type=' + d.thinking.type);
                if (d.thinking.budget_tokens !== undefined) th.push('budget_tokens=' + d.thinking.budget_tokens);
            }
            tc = (d.generationConfig && d.generationConfig.thinkingConfig)
                || (d.generation_config && d.generation_config.thinking_config)
                || (d.config && d.config.thinkingConfig);
            if (tc) {
                if (tc.thinkingLevel !== undefined) th.push('thinkingLevel=' + tc.thinkingLevel);
                if (tc.thinking_level !== undefined) th.push('thinking_level=' + tc.thinking_level);
                if (tc.thinkingBudget !== undefined) th.push('thinkingBudget=' + tc.thinkingBudget);
                if (tc.thinking_budget !== undefined) th.push('thinking_budget=' + tc.thinking_budget);
            }
            if (th.length) m.thinking = th.join(', ');
        }
        return m;
    }

    function respMeta(events) {
        var m = {};
        (events || []).forEach(function (d) {
            if (!d) return;
            if (d.data && d.data.CompletionChunk) d = d.data.CompletionChunk;
            else if (d.data && d.data.choices) d = d.data;
            var r = d.response && typeof d.response === 'object' ? d.response : null;
            var src = [d, r];
            for (var i = 0; i < src.length; i++) {
                var s = src[i];
                if (!s) continue;
                if (s.model !== undefined && !m.model) m.model = s.model;
                if (s.service_tier !== undefined && !m.service_tier) m.service_tier = s.service_tier;
                if (s.serviceTier !== undefined && !m.service_tier) m.service_tier = s.serviceTier;
            }
        });
        return m;
    }

    function pick() {
        for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
    }

    // 맨 아래 요약용 모델/토큰/비용. 스트림에 여러 번 실려 오면 뒤에 온 값이 이긴다.
    function summaryOf(events) {
        var s = {};
        function num(k, v) { if (typeof v === 'number' && isFinite(v)) s[k] = v; }
        function str(k, v) { if (typeof v === 'string' && v) s[k] = v; }
        (events || []).forEach(function (d) {
            if (!d) return;
            if (d.data && d.data.CompletionChunk) d = d.data.CompletionChunk;
            else if (d.data && d.data.choices) d = d.data;
            var md = d.metadata && typeof d.metadata === 'object' ? d.metadata : {};
            var msg = d.response && typeof d.response === 'object' ? d.response
                : (d.message && typeof d.message === 'object' ? d.message : {});
            str('model', pick(d.model, d.modelVersion, msg.model));
            str('model', md.used_model);       // LLM Gateway: 실제로 라우팅된 모델
            str('provider', d.provider);       // OpenRouter
            str('provider', md.used_provider); // LLM Gateway
            var u = d.usage || msg.usage || d.usageMetadata || md.usage;
            if (!u || typeof u !== 'object') return;
            if (u.promptTokenCount !== undefined) { // Gemini: 출력 = 본문 + thinking
                num('in', u.promptTokenCount);
                num('out', (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0));
                num('reason', u.thoughtsTokenCount);
                num('cached', u.cachedContentTokenCount);
                num('total', u.totalTokenCount);
                return;
            }
            var ind = u.prompt_tokens_details || u.input_tokens_details || {};
            var outd = u.completion_tokens_details || u.output_tokens_details || {};
            // Anthropic의 input_tokens는 캐시 읽기/쓰기분이 빠진 값이라 더해야 실제 입력이 된다.
            // shortcut: Bedrock(inputTokens)은 캐시분을 따로 더하지 않음, Bedrock 캐시를 쓰게 되면 같은 처리 추가
            var anth = u.prompt_tokens === undefined && (u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined);
            num('in', anth ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
                : pick(u.prompt_tokens, u.input_tokens, u.inputTokens));
            num('cached', pick(ind.cached_tokens, anth ? u.cache_read_input_tokens : undefined));
            num('out', pick(u.completion_tokens, u.output_tokens, u.outputTokens));
            num('reason', pick(outd.reasoning_tokens, u.reasoning_tokens));
            num('total', pick(u.total_tokens, u.totalTokens));
            var cd = u.cost_details || {};
            num('cost', u.cost);
            num('costIn', pick(cd.input_cost, cd.upstream_inference_prompt_cost));
            num('costOut', pick(cd.output_cost, cd.upstream_inference_completions_cost));
        });
        return s;
    }

    // { model, rows: [[그룹, 항목, 값, 하위항목]] }. 열 맞춤은 renderSum의 grid가 한다.
    function sumRows(s, reqModel) {
        var model = String(s.model || reqModel || ''), prov = s.provider || '';
        if (prov && model.indexOf(prov + '/') === 0) model = model.slice(prov.length + 1);
        model = prov && model ? prov + ' / ' + model : (model || prov);
        var tok = function (v) { return v === undefined ? undefined : v.toLocaleString('en-US'); };
        var usd = function (v) { return v === undefined ? undefined : '$' + v.toFixed(6); };
        var total = s.total !== undefined ? s.total : (s.in !== undefined && s.out !== undefined ? s.in + s.out : undefined);
        var rows = [
            ['Tokens', 'in', tok(s.in)],
            ['Tokens', 'cached', s.cached ? tok(s.cached) : undefined, 1],
            ['Tokens', 'out', tok(s.out)],
            ['Tokens', 'reasoning', s.reason ? tok(s.reason) : undefined, 1],
            ['Tokens', 'total', tok(total)],
            ['Cost', 'in', usd(s.costIn)],
            ['Cost', 'out', usd(s.costOut)],
            ['Cost', 'total', usd(s.cost)]
        ].filter(function (x) { return x[2] !== undefined; });
        return model || rows.length ? { model: model, rows: rows } : null;
    }

    function mergeMeta(a, b) {
        var m = {}, k;
        a = a || {}; b = b || {};
        for (k in a) m[k] = a[k];
        for (k in b) if (b[k] !== undefined && b[k] !== '') m[k] = b[k];
        return m;
    }

    var META_LABELS = [
        ['model', 'Model'],
        ['service_tier', 'Service tier'],
        ['reasoning_effort', 'Reasoning effort'],
        ['reasoning_summary', 'Reasoning summary'],
        ['verbosity', 'Verbosity'],
        ['thinking', 'Thinking']
    ];
    function metaLines(m) {
        var s = '';
        if (!m) return s;
        META_LABELS.forEach(function (p) {
            var v = m[p[0]];
            if (v !== undefined && v !== '') s += '\n' + p[1] + ': ' + v;
        });
        return s;
    }

    function bodyText(b) {
        if (b === undefined || b === null) return null;
        if (typeof b === 'string') return b;
        if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return String(b);
        return null;
    }

    // 상태는 누적하지 않고 마지막 값으로 덮어쓴다.
    // (예전에는 in_progress → completed가 둘 다 남아 [stop: in_progress, completed]로 보였다)
    var STATUS_MAP = {
        stop: 'done', end_turn: 'done', completed: 'done', complete: 'done',
        stop_sequence: 'done', finished: 'done', done: 'done',
        length: 'length', max_tokens: 'length', model_length: 'length',
        content_filter: 'content_filter', safety: 'content_filter',
        prohibited_content: 'content_filter', blocklist: 'content_filter',
        recitation: 'recitation', refusal: 'refusal',
        tool_calls: 'tool_calls', tool_use: 'tool_calls', function_call: 'tool_calls',
        in_progress: 'in_progress', incomplete: 'incomplete',
        failed: 'failed', error: 'failed',
        cancelled: 'cancelled', canceled: 'cancelled'
    };
    function normStatus(v) {
        if (v === undefined || v === null || v === '') return '';
        v = String(v);
        var k = v.toLowerCase();
        return STATUS_MAP[k] || v;
    }

    // 완성된 JSON 인자는 들여쓰기해서 보여준다. 스트리밍 중(불완전)이면 그대로 둔다.
    function pretty(s) {
        try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { return s; }
    }
    // tool 인자는 JSON 텍스트라 문자열 안 줄바꿈이 \n 이스케이프로 남는다. 실제 줄바꿈으로 편다.
    // \\ (원래 백슬래시)는 먼저 짝지어 건너뛰므로 \\n 은 그대로 남는다.
    function unesc(s) {
        return s.replace(/\\(\\|n)/g, function (m, c) { return c === 'n' ? '\n' : m; });
    }

    // 반환: { text: string, status: string }
    function parseBody(raw) {
        var events = parseEvents(raw);
        var segs = [];
        var status = '';

        function put(kind, v) {
            if (v === undefined || v === null || v === '') return;
            v = typeof v === 'string' ? v : String(v);
            if (!v) return;
            var last = segs[segs.length - 1];
            if (last && last.kind === kind && !last.call) last.text += v;
            else segs.push({ kind: kind, text: v });
        }
        function setStatus(v) {
            var n = normStatus(v);
            if (n) status = n;
        }
        function parts(p) {
            if (!Array.isArray(p)) return;
            p.forEach(function (x) {
                if (!x) return;
                if (x.thought === true) { put('reasoning', x.text); return; }
                put('text', x.text);
                if (x.type === 'text') put('text', x.content);
                if (x.functionCall) put('tool', JSON.stringify(x.functionCall));
                if (x.functionResponse) put('tool', JSON.stringify(x.functionResponse));
            });
        }
        function reason(x) {
            if (!x) return;
            if (typeof x === 'string') { put('reasoning', x); return; }
            put('reasoning', x.text);
            if (x.reasoningText) {
                put('reasoning', typeof x.reasoningText === 'string' ? x.reasoningText : x.reasoningText.text);
            }
        }

        // Responses API의 tool 호출은 output_item(id / output_index) 단위로 온다.
        // delta를 한 덩어리에 이어 붙이면 병렬 호출 인자가 서로 섞이므로 호출별 슬롯에 모은다.
        var calls = {};
        function slot(ix, id, name) {
            var s = (id && calls['i' + id]) || (ix !== undefined && calls['o' + ix]);
            if (!s) { s = { kind: 'tool', call: true, name: '', args: '' }; segs.push(s); }
            if (id) calls['i' + id] = s;
            if (ix !== undefined) calls['o' + ix] = s;
            if (name) s.name = name;
            return s;
        }
        // .done / output_item에 실린 완성본으로 덮어쓴다 (function은 arguments, custom은 input, code_interpreter는 code)
        function fullArgs(s, x) {
            var v = x.arguments !== undefined ? x.arguments : (x.input !== undefined ? x.input : x.code);
            if (v === undefined || v === null || v === '') return;
            s.args = typeof v === 'string' ? v : JSON.stringify(v);
            s.full = true;
        }

        var RESP_DELTA = {
            'response.output_text.delta': 'text',
            'response.refusal.delta': 'refusal',
            'response.reasoning_summary_text.delta': 'reasoning',
            'response.reasoning_text.delta': 'reasoning'
        };
        var TOOL_DELTA = {
            'response.function_call_arguments.delta': 1,
            'response.mcp_call_arguments.delta': 1,
            'response.custom_tool_call_input.delta': 1,
            'response.code_interpreter_call_code.delta': 1
        };
        var TOOL_DONE = {
            'response.function_call_arguments.done': 1,
            'response.mcp_call_arguments.done': 1,
            'response.custom_tool_call_input.done': 1,
            'response.code_interpreter_call_code.done': 1
        };
        var TOOL_ITEM = { function_call: 1, mcp_call: 1, custom_tool_call: 1, code_interpreter_call: 1 };

        events.forEach(function (d) {
            if (!d) return;
            if (d.data && d.data.CompletionChunk) d = d.data.CompletionChunk;
            else if (d.data && d.data.choices) d = d.data;

            // ── OpenAI Responses API (스트리밍) ──
            if (typeof d.type === 'string' && RESP_DELTA[d.type] !== undefined) {
                put(RESP_DELTA[d.type], d.delta);
                return;
            }
            if (TOOL_DELTA[d.type]) {
                var cs = slot(d.output_index, d.item_id);
                if (!cs.full && typeof d.delta === 'string') cs.args += d.delta;
                return;
            }
            if (TOOL_DONE[d.type]) {
                fullArgs(slot(d.output_index, d.item_id, d.name), d);
                return;
            }
            if ((d.type === 'response.output_item.added' || d.type === 'response.output_item.done') && d.item) {
                if (TOOL_ITEM[d.item.type]) fullArgs(slot(d.output_index, d.item.id, d.item.name || d.item.type), d.item);
                return;
            }
            if (typeof d.type === 'string' && /^response\.[a-z_.]+\.done$/.test(d.type)) return;
            if (d.type === 'response.created' || d.type === 'response.in_progress') {
                setStatus((d.response && d.response.status) || 'in_progress');
                return;
            }
            if (d.type === 'response.incomplete' || d.type === 'response.failed') {
                var det = d.response && d.response.incomplete_details;
                setStatus(det && det.reason ? det.reason : (d.type === 'response.failed' ? 'failed' : 'incomplete'));
                return;
            }
            if (d.type === 'response.completed' && d.response) {
                setStatus(d.response.status || 'completed');
                return;
            }
            if (d.type === 'error' || d.type === 'response.error') {
                status = 'failed: ' + (d.message || (d.error && d.error.message) || 'unknown');
                return;
            }

            // ── Responses API (비스트리밍) ──
            var respObj = (d.object === 'response' && d.output) ? d : (d.response && d.response.output ? d.response : null);
            if (respObj && Array.isArray(respObj.output)) {
                respObj.output.forEach(function (item, i) {
                    if (!item) return;
                    if (item.type === 'reasoning') {
                        (item.summary || []).forEach(function (s) { put('reasoning', s && s.text); });
                        (item.content || []).forEach(function (s) { put('reasoning', s && s.text); });
                    } else if (item.type === 'message') {
                        (item.content || []).forEach(function (c) {
                            if (!c) return;
                            if (c.type === 'output_text') put('text', c.text);
                            else if (c.type === 'refusal') put('refusal', c.refusal);
                            else put('text', c.text);
                        });
                    } else if (TOOL_ITEM[item.type]) {
                        fullArgs(slot(i, item.id, item.name || item.type), item);
                    }
                });
                setStatus(respObj.status);
                return;
            }

            // ── Anthropic ──
            if (d.type === 'content_block_delta' && d.delta) {
                if (d.delta.type === 'text_delta') put('text', d.delta.text);
                else if (d.delta.type === 'thinking_delta') put('reasoning', d.delta.thinking);
                else if (d.delta.type === 'input_json_delta') put('tool', d.delta.partial_json || '');
                else {
                    put('text', d.delta.text);
                    put('reasoning', d.delta.thinking);
                    put('tool', d.delta.partial_json);
                }
                reason(d.delta.reasoningContent);
                return;
            }
            if (d.type === 'message_start') { setStatus('in_progress'); return; }
            if (d.type === 'message_delta' && d.delta) { setStatus(d.delta.stop_reason); return; }
            if (d.type === 'message' && Array.isArray(d.content)) {
                d.content.forEach(function (c) {
                    if (!c) return;
                    if (c.type === 'thinking') put('reasoning', c.thinking);
                    else if (c.type === 'tool_use') put('tool', JSON.stringify(c.input));
                    else put('text', c.text);
                });
                setStatus(d.stop_reason);
                return;
            }

            // ── OpenAI Chat Completions ──
            if (d.choices) {
                d.choices.forEach(function (ch) {
                    if (!ch) return;
                    var src = ch.delta || ch.message;
                    if (src) {
                        if (typeof src.content === 'string') put('text', src.content);
                        else parts(src.content);
                        put('reasoning', src.reasoning);
                        put('reasoning', src.reasoning_content);
                        put('refusal', src.refusal);
                        if (src.function_call) put('tool', src.function_call.arguments);
                        if (src.tool_calls) src.tool_calls.forEach(function (t) { put('tool', t.function && t.function.arguments); });
                        if (src.ThinkChunk) put('reasoning', src.ThinkChunk.thinking);
                    }
                    if (typeof ch.text === 'string' && !src) put('text', ch.text);
                    setStatus(ch.finish_reason);
                });
                return;
            }

            // ── Gemini ──
            if (d.candidates) {
                d.candidates.forEach(function (c) {
                    if (!c) return;
                    if (c.content) parts(c.content.parts);
                    setStatus(c.finishReason);
                });
                if (d.promptFeedback && d.promptFeedback.blockReason) setStatus(d.promptFeedback.blockReason);
                return;
            }

            // ── Bedrock ──
            if (d.contentBlockDelta && d.contentBlockDelta.delta) {
                var bd = d.contentBlockDelta.delta;
                put('text', bd.text);
                reason(bd.reasoningContent);
                if (bd.toolUse) put('tool', bd.toolUse.input);
                return;
            }
            if (d.messageStop) { setStatus(d.messageStop.stopReason); return; }

            // ── 기타 ──
            if (d.completion) put('text', d.completion);
            if (d.message && typeof d.message === 'object' && !Array.isArray(d.message.content)) {
                put('text', d.message.content);
                put('reasoning', d.message.thinking);
            }
            if (d.done_reason) setStatus(d.done_reason);
        });

        var text = '';
        if (segs.length) {
            var kinds = {};
            segs.forEach(function (s) { kinds[s.kind] = 1; });
            var multi = Object.keys(kinds).length > 1;
            var LABEL = { reasoning: '── reasoning ──', text: '── text ──', tool: '── tool ──', refusal: '── refusal ──' };
            text = segs.map(function (s) {
                if (s.call) return '── tool: ' + (s.name || '?') + ' ──\n' + unesc(pretty(s.args));
                var t = s.kind === 'tool' ? unesc(s.text) : s.text;
                return multi ? LABEL[s.kind] + '\n' + t : t;
            }).join('\n\n');
        }
        return { text: text, status: status, events: events, sum: summaryOf(events) };
    }
    // ══════════════════════════════════════════════════════════════════════
    // PARSER-END
    // ══════════════════════════════════════════════════════════════════════

    function readReqMeta(r, u, op) {
        var t = bodyText(op && op.body);
        if (t !== null) { r.qm = reqMeta(t, r.target || r.u); return; }
        if (u && typeof u.clone === 'function') {
            try {
                u.clone().text().then(function (x) {
                    r.qm = reqMeta(x, r.target || r.u);
                    rn();
                    if (S === r.id) rd(true);
                }).catch(function () { });
            } catch (e) { }
        }
    }

    function rn() {
        ls.innerHTML = '';
        bg.textContent = R.length;
        document.getElementById('_t').textContent = 'Requests (' + R.length + ')';
        R.forEach(function (r) {
            var i = document.createElement('div');
            i.style.cssText = 'padding:6px 8px;border-bottom:1px solid #222;cursor:pointer;' + (S === r.id ? 'background:#030' : '');
            var c = r.st === 'pending' ? '#ff0' : r.st === 'done' ? '#0f0' : '#f00';
            var dur = r.t1 ? (r.t1 - r.t0) + 'ms' : ((Date.now() - r.t0) + 'ms…');
            var shown = r.target || r.u;
            var via = r.target ? '<span style="color:#6af">via /proxy2</span> ' : '';
            i.innerHTML = '<div style="display:flex;justify-content:space-between;gap:6px"><span style="color:' + c + '">[' + r.st + '] ' + r.m + ' ' + (r.hs || '') + '</span><span style="color:#888;font-size:10px">' + r.tss + ' <span style="color:#6af">' + dur + '</span></span></div><div style="color:#888;font-size:10px;word-break:break-all">' + via + String(shown || '').substr(0, 70) + '</div>';
            i.onclick = function () { S = r.id; rn(); rd(true); };
            ls.appendChild(i);
        });
    }

    // Raw 뷰는 DevTools EventStream처럼 이벤트만 보여준다.
    // OpenRouter(`: OPENROUTER PROCESSING`), LLM Gateway(`: ping`)의 SSE 주석과
    // 빈 줄 덩어리는 지우고 주석 개수만 헤더에 남긴다. {"type":"keepalive"} 같은
    // data 이벤트는 진짜 이벤트이므로 그대로 둔다.
    var SSE_COMMENT = /^:[^\n]*(?:\n|$)/gm;
    function cleanRaw(raw) {
        if (!/^(?:data:|event:|:)/m.test(raw)) return { text: raw, cm: 0 };
        var n = 0;
        var t = raw.replace(/\r\n/g, '\n').replace(SSE_COMMENT, function () { n++; return ''; });
        return { text: t.replace(/\n(?:[ \t]*\n)+/g, '\n\n').replace(/^\s+/, ''), cm: n };
    }

    // 청크가 들어올 때마다 join / 재파싱하면 O(n²)가 된다. 청크 수를 키로
    // 캐시해서, 새 청크가 없으면 이전 결과를 그대로 쓴다.
    function rawOf(r) {
        if (r._rawN !== r.ch.length) {
            var c = cleanRaw(r.ch.join(''));
            r._raw = c.text; r._cm = c.cm; r._rawN = r.ch.length;
        }
        return r._raw;
    }
    function parsedOf(r) {
        if (r._pN !== r.ch.length) { r._p = parseBody(rawOf(r)); r._pN = r.ch.length; }
        return r._p;
    }

    function headerText(r) {
        var dur = r.t1 ? (r.t1 - r.t0) + 'ms' : ((Date.now() - r.t0) + 'ms (ongoing)');
        var p = parsedOf(r);
        var mi = metaLines(mergeMeta(respMeta(p.events), r.qm));
        var pk = ['x-risu-turn-id', 'x-agent-task-id', 'x-interaction-id', 'x-initiator'];
        var hi = '';
        pk.forEach(function (k) { if (r.rh && r.rh[k]) hi += '\n' + k + ': ' + r.rh[k]; });
        var status = p.status || (r.st === 'pending' ? 'in_progress' : '');
        return 'URL: ' + (r.target || r.u)
            + (r.target ? '\nRoute: ' + r.u + ' (PocketRisu proxy)' : '\nRoute: direct')
            + '\nMethod: ' + r.m
            + '\nHTTP: ' + r.st + (r.hs ? ' (' + r.hs + ')' : '')
            + (status ? '\nStatus: ' + status : '')
            + '\nStarted: ' + r.tss
            + '\nDuration: ' + dur
            + '\nChunks: ' + r.ch.length
            + (r._cm ? '\nSSE comments: ' + r._cm + ' (Raw에서 숨김)' : '')
            + '\nView: ' + V
            + mi + hi
            + '\n\n--- Response ---';
    }

    function viewBody(r) {
        var p = parsedOf(r);
        var body = V === 'text' ? p.text : rawOf(r);
        if (V === 'text' && body === '') body = '(추출된 텍스트 없음 — Raw 탭 확인)';
        var cut = '';
        if (body.length > MAX_VIEW) {
            cut = '[앞부분 ' + (body.length - MAX_VIEW) + '자 생략 — Copy 버튼은 전체를 복사합니다]\n\n';
            body = body.slice(body.length - MAX_VIEW);
        }
        var status = p.status || (r.st === 'pending' ? 'in_progress' : '');
        return cut + body + (status ? '\n\n[status: ' + status + ']' : '');
    }

    // 페이지 CSS 때문에 패널이 고정폭 글꼴이 아닐 수 있어서, 공백 대신 grid로 열을 맞춘다.
    // 모델 줄과 숫자 표는 따로 grid지만 첫 열 너비(4.5em)와 간격을 같게 둬서 세로선이 맞는다.
    function renderSum(d) {
        var k = d ? JSON.stringify(d) : '';
        if (sumEl.__v === k) return;
        sumEl.__v = k;
        sumEl.textContent = '';
        sumEl.style.display = d ? 'block' : 'none';
        if (!d) return;
        function cell(parent, text, css) {
            var e = document.createElement('div');
            e.textContent = text;
            e.style.cssText = css || '';
            parent.appendChild(e);
            return e;
        }
        var GRID = 'display:grid;column-gap:12px;row-gap:2px;margin-top:4px;grid-template-columns:4.5em ';
        cell(sumEl, '--- Summary ---');
        if (d.model) {
            var mr = cell(sumEl, '', GRID + 'minmax(0,1fr)');
            cell(mr, 'Model');
            cell(mr, d.model, 'color:#0f0;overflow-wrap:anywhere');
        }
        if (!d.rows.length) return;
        var g = cell(sumEl, '', GRID + 'max-content max-content;font-variant-numeric:tabular-nums');
        d.rows.forEach(function (x, i) {
            var first = !i || d.rows[i - 1][0] !== x[0];
            var gap = first && i ? 'margin-top:6px;' : '';
            cell(g, first ? x[0] : '', gap);
            cell(g, x[1], gap + (x[3] ? 'padding-left:1em;color:#888' : ''));
            cell(g, x[2], gap + 'text-align:right;color:#0f0' + (x[1] === 'total' ? ';font-weight:bold' : ''));
        });
    }

    function rd(force) {
        var r = R.find(function (x) { return x.id === S; });
        if (!r) { hdrEl.textContent = ''; bodyEl.textContent = 'Select a request...'; renderSum(null); jb.style.display = 'none'; return; }
        var stick = force || atB();
        var h = headerText(r);
        if (hdrEl.textContent !== h) hdrEl.textContent = h;
        var b = viewBody(r);
        // 동일 문자열이면 DOM을 건드리지 않는다 (레이아웃 재계산 회피)
        if (bodyEl.__v !== b) { bodyEl.textContent = b; bodyEl.__v = b; }
        renderSum(sumRows(parsedOf(r).sum, r.qm && r.qm.model));
        if (stick) dt.scrollTop = dt.scrollHeight;
        jb.style.display = atB() ? 'none' : 'block';
    }

    // 스트리밍 중에는 프레임당 한 번으로 묶는다.
    var rafPending = false;
    function rdSoon() {
        if (rafPending) return;
        rafPending = true;
        (window.requestAnimationFrame || setTimeout)(function () {
            rafPending = false;
            rd(false);
        }, 16);
    }

    document.getElementById('_cl').onclick = function (e) { e.stopPropagation(); R = []; S = null; rn(); rd(true); };
    document.getElementById('_cs').onclick = function (e) { e.stopPropagation(); pn.style.display = 'none'; P = false; };
    document.getElementById('_cp').onclick = function (e) {
        e.stopPropagation();
        var r = R.find(function (x) { return x.id === S; });
        if (!r) return;
        var p = parsedOf(r);
        var status = p.status || (r.st === 'pending' ? 'in_progress' : '');
        var txt = headerText(r) + '\n' + (V === 'text' ? p.text : rawOf(r)) + (status ? '\n\n[status: ' + status + ']' : '');
        var btn = e.target;
        var done = function () { var old = btn.textContent; btn.textContent = 'OK'; setTimeout(function () { btn.textContent = old; }, 900); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).then(done).catch(function () { });
        } else {
            var ta = document.createElement('textarea');
            ta.value = txt; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); done(); } catch (err) { }
            ta.remove();
        }
    };

    var dg = false, mv = false, sx, sy, ox, oy;
    fab.addEventListener('pointerdown', function (e) {
        dg = true; mv = false; sx = e.clientX; sy = e.clientY;
        var rc = fab.getBoundingClientRect();
        ox = rc.left; oy = rc.top;
        fab.setPointerCapture(e.pointerId);
    });
    fab.addEventListener('pointermove', function (e) {
        if (!dg) return;
        var dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) mv = true;
        fab.style.left = (ox + dx) + 'px';
        fab.style.top = (oy + dy) + 'px';
        fab.style.right = 'auto';
    });
    fab.addEventListener('pointerup', function () {
        dg = false;
        if (!mv) { P = !P; pn.style.display = P ? 'flex' : 'none'; }
    });
    setInterval(function () { if (P && R.some(function (r) { return r.st === 'pending'; })) rn(); }, 500);

    // ── XHR 후킹 ────────────────────────────────────────────────────────────
    if (window.XMLHttpRequest) {
        if (!window.__sseTapXHROpen) {
            window.__sseTapXHROpen = XMLHttpRequest.prototype.open;
            window.__sseTapXHRSend = XMLHttpRequest.prototype.send;
            window.__sseTapXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
        }
        XMLHttpRequest.prototype.open = function (m, u) {
            this.__sseTap = { m: m || 'GET', u: u, h: {}, pos: 0 };
            return window.__sseTapXHROpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
            if (this.__sseTap) this.__sseTap.h[String(k).toLowerCase()] = v;
            return window.__sseTapXHRSetRequestHeader.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (b) {
            var x = this, a = x.__sseTap;
            if (a && ok(a.u, a.m)) {
                var now = new Date();
                var tgt = realTarget(a.u, a.h);
                var r = { id: ++ID, u: a.u, target: tgt, m: a.m, st: 'pending', ch: [], hs: null, t0: Date.now(), tss: ts(now), t1: null, rh: a.h || {}, qm: reqMeta(bodyText(b), tgt || a.u) };
                R.unshift(r);
                if (R.length > 50) R.pop();
                rn();
                var upd = function (done) {
                    try { r.hs = x.status || r.hs; } catch (e) { }
                    try {
                        var txt = x.responseText;
                        if (typeof txt === 'string' && txt.length > a.pos) { r.ch.push(txt.slice(a.pos)); a.pos = txt.length; }
                    } catch (e) { }
                    if (done) { r.st = (x.status >= 400 ? 'error' : 'done'); r.t1 = Date.now(); }
                    if (done) { rn(); if (S === r.id) rd(false); }
                    else if (S === r.id) rdSoon();
                };
                x.addEventListener('progress', function () { upd(false); });
                x.addEventListener('loadend', function () { upd(true); });
                x.addEventListener('error', function () { r.st = 'error'; r.t1 = Date.now(); rn(); if (S === r.id) rd(false); });
            }
            return window.__sseTapXHRSend.apply(this, arguments);
        };
    }

    // ── fetch 후킹 ──────────────────────────────────────────────────────────
    // 인자는 원본 그대로 넘긴다. 헤더를 재구성하면 PocketRisu의 risu-auth /
    // file-path 같은 커스텀 헤더가 유실되어 서버가 400을 뱉는다.
    window.fetch = function () {
        var u = arguments[0], op = arguments[1] || {};
        var us = typeof u === 'string' ? u : (u && u.url);
        var mt = op.method || (u && u.method) || 'GET';
        if (!ok(us, mt)) return o.apply(this, arguments);

        var now = new Date();
        var hdrs = {};
        try {
            var rh = op.headers || (u && u.headers);
            if (rh) {
                if (typeof rh.forEach === 'function') rh.forEach(function (v, k) { hdrs[k.toLowerCase()] = v; });
                else if (Array.isArray(rh)) rh.forEach(function (p) { hdrs[p[0].toLowerCase()] = p[1]; });
                else Object.keys(rh).forEach(function (k) { hdrs[k.toLowerCase()] = rh[k]; });
            }
        } catch (e) { }

        var tgt = realTarget(us, hdrs);
        var r = { id: ++ID, u: us, target: tgt, m: mt, st: 'pending', ch: [], hs: null, t0: Date.now(), tss: ts(now), t1: null, rh: hdrs, qm: reqMeta(null, tgt || us) };
        readReqMeta(r, u, op);
        R.unshift(r);
        if (R.length > 50) R.pop();
        rn();

        return o.apply(this, arguments).then(function (rs) {
            r.hs = rs.status;
            if (!rs.body) {
                try {
                    rs.clone().text().then(function (t) {
                        if (t) r.ch.push(t);
                        r.st = 'done'; r.t1 = Date.now(); rn(); if (S === r.id) rd(false);
                    }).catch(function () {
                        r.st = 'done'; r.t1 = Date.now(); rn(); if (S === r.id) rd(false);
                    });
                } catch (e) {
                    r.st = 'done'; r.t1 = Date.now(); rn(); if (S === r.id) rd(false);
                }
                return rs;
            }
            var t = rs.body.tee();
            var rr = t[0].getReader();
            var dc = new TextDecoder();
            (function lp() {
                rr.read().then(function (x) {
                    if (x.done) { r.st = 'done'; r.t1 = Date.now(); rn(); if (S === r.id) rd(false); return; }
                    r.ch.push(dc.decode(x.value, { stream: true }));
                    if (S === r.id) rdSoon();
                    lp();
                }).catch(function (e) {
                    r.st = 'error'; r.t1 = Date.now(); r.ch.push('\n[err] ' + e); rn(); if (S === r.id) rd(false);
                });
            })();
            return new Response(t[1], { status: rs.status, statusText: rs.statusText, headers: rs.headers });
        }).catch(function (e) {
            r.st = 'error'; r.t1 = Date.now(); r.ch.push('[fetch err] ' + e); rn(); if (S === r.id) rd(false);
            throw e;
        });
    };

    rn();
})();
