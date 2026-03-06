/**
 * Swipe Pregeneration Extension for SillyTavern
 *
 * Feature 1: "Generate in Background" button next to the swipe-right chevron.
 *   Clicking it starts a swipe generation while keeping the current message readable
 *   via a visual overlay. When generation completes, the view automatically snaps
 *   back to the original swipe so the user can swipe right at their own pace.
 *
 * Feature 2: "Swipe pre-generation" entry in the Extensions wand menu.
 *   Opens a modal to batch-pre-generate N swipes with an optional progress bar.
 */

import {
    event_types,
    chat,
    isGenerating,
    saveChatConditional,
    addOneMessage,
    refreshSwipeButtons,
    saveSettingsDebounced,
} from '../../../../script.js';

import { getContext, extension_settings } from '../../../extensions.js';
import { SWIPE_DIRECTION, SWIPE_SOURCE } from '../../../constants.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { t } from '../../../i18n.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const MODULE_NAME   = 'swipe_pregen';
const PROGRESS_ID   = `${MODULE_NAME}_progress_bar`;
const BTN_CLASS     = 'sp_bg_gen_btn';

const DEFAULT_SETTINGS = {
    defaultBatchSize : 3,
    showProgressBar  : true,
};

// ─── State ────────────────────────────────────────────────────────────────────

let isBackgroundGenerating = false;  // single-gen lock
let batchAbort             = false;  // batch abort flag

/** Direct reference to the frozen real .mes element, for height-lock cleanup. */
let $frozenMes = null;

/** Original inline styles we temporarily override during the freeze. */
let frozenStyles = null;

/** MutationObserver that keeps .mes_text showing the frozen HTML during streaming. */
let _frozenObserver = null;

// ─── Settings ─────────────────────────────────────────────────────────────────

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extension_settings[MODULE_NAME];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns true when it is safe to start a background generation. */
function canStart() {
    if (isBackgroundGenerating) return false;
    if (isGenerating())         return false;

    const ctx = getContext();
    if (!ctx?.chat?.length) return false;

    const last = ctx.chat[ctx.chat.length - 1];
    return !!(last && !last.is_user && !last.is_system);
}

/**
 * Freeze the last message by (a) locking the .mes container height so it can't
 * grow or shrink, and (b) using a MutationObserver to instantly restore the
 * original rendered HTML whenever SillyTavern's streaming overwrites .mes_text.
 *
 * This keeps the real element in place in the normal document flow so the user
 * can scroll freely and reads the original message throughout generation.
 *
 * @param {jQuery} $lastMes  - The .mes element (last_mes)
 */
function createFreezeOverlay($lastMes) {
    const $mesText = $lastMes.find('.mes_text').first();
    if (!$mesText.length) return;

    const mesTextEl  = $mesText[0];
    const frozenHtml = mesTextEl.innerHTML;  // snapshot of fully-rendered content

    // Lock the message container at its current height so neither the streaming
    // placeholder "..." nor an eventually longer generated message resizes it.
    frozenStyles = {
        mesHeight    : $lastMes[0].style.height,
        mesMinHeight : $lastMes[0].style.minHeight,
        mesOverflow  : $lastMes[0].style.overflow,
    };
    $lastMes.css({
        height    : $lastMes.outerHeight(),
        minHeight : $lastMes.outerHeight(),
        overflow  : 'hidden',
    });

    // Watch .mes_text for any change and immediately restore the frozen HTML.
    // Disconnect → mutate → reconnect prevents infinite recursion.
    // requestAnimationFrame batches rapid streaming updates to ≤1 restore/frame.
    let rafPending = false;
    _frozenObserver = new MutationObserver(() => {
        if (rafPending || !_frozenObserver) return;
        rafPending = true;
        requestAnimationFrame(() => {
            if (!_frozenObserver) { rafPending = false; return; }
            _frozenObserver.disconnect();
            mesTextEl.innerHTML = frozenHtml;
            _frozenObserver.observe(mesTextEl, { childList: true, subtree: true, characterData: true });
            rafPending = false;
        });
    });
    _frozenObserver.observe(mesTextEl, { childList: true, subtree: true, characterData: true });

    $frozenMes = $lastMes;
}

/** Stop the freeze observer and restore all temporarily-overridden styles. */
function removeOverlay() {
    if (_frozenObserver) {
        _frozenObserver.disconnect();
        _frozenObserver = null;
    }

    if ($frozenMes && frozenStyles) {
        $frozenMes.css({
            height    : frozenStyles.mesHeight,
            minHeight : frozenStyles.mesMinHeight,
            overflow  : frozenStyles.mesOverflow,
        });
    }

    $frozenMes   = null;
    frozenStyles = null;
}

/**
 * Capture the minimal state needed to fully restore the viewed swipe.
 * @param {object} msg  - chat message object
 * @param {number} id   - swipe_id to save
 */
function captureState(msg, id) {
    const info = msg.swipe_info?.[id] ?? {};
    return {
        swipeId      : id,
        mes          : msg.mes,
        send_date    : msg.send_date,
        gen_started  : msg.gen_started,
        gen_finished : msg.gen_finished,
        extra        : JSON.parse(JSON.stringify(msg.extra ?? {})),
        swipe_info   : JSON.parse(JSON.stringify(info)),
    };
}

/**
 * Restore a chat message to a previously captured state.
 * Reads back from swipe_info if available (which has the canonical timestamps).
 *
 * @param {object} msg   - live chat message object (mutated in place)
 * @param {object} state - previously returned by captureState()
 */
function restoreState(msg, state) {
    msg.swipe_id = state.swipeId;

    // Prefer the data from swipe_info as it may have been updated during gen
    const liveInfo = msg.swipe_info?.[state.swipeId];
    if (liveInfo) {
        msg.mes          = msg.swipes[state.swipeId] ?? state.mes;
        msg.send_date    = liveInfo.send_date    ?? state.send_date;
        msg.gen_started  = liveInfo.gen_started  ?? state.gen_started;
        msg.gen_finished = liveInfo.gen_finished ?? state.gen_finished;
        msg.extra        = JSON.parse(JSON.stringify(liveInfo.extra ?? state.extra));
    } else {
        msg.mes          = state.mes;
        msg.send_date    = state.send_date;
        msg.gen_started  = state.gen_started;
        msg.gen_finished = state.gen_finished;
        msg.extra        = JSON.parse(JSON.stringify(state.extra));
    }
}

// ─── Core: single background generation ──────────────────────────────────────

/**
 * Trigger a single swipe generation in the background.
 * The current swipe remains readable via a freeze overlay.
 *
 * Awaits the entire swipe() call (including its internal endSwipe cleanup) so
 * we restore the view AFTER SillyTavern has finished all its house-keeping.
 * This avoids the spurious shake/red-flash that would happen if we restored
 * swipe_id before endSwipe() ran its "did the swipe succeed?" check.
 *
 * @param  {{ silent?: boolean }} [opts]  Pass `silent: true` to suppress the per-swipe success toast (used by batch mode).
 * @returns {Promise<boolean>} true if a new swipe was successfully generated.
 */
async function runBackgroundGeneration({ silent = false } = {}) {
    if (!canStart()) return false;

    const ctx       = getContext();
    const lastIdx   = ctx.chat.length - 1;
    const lastMsg   = ctx.chat[lastIdx];
    const origSwipe = lastMsg.swipe_id ?? 0;
    const origCount = lastMsg.swipes?.length ?? 1;

    // Ensure swipes array is initialised (mirrors what swipe() does internally)
    if (!Array.isArray(lastMsg.swipes)) {
        lastMsg.swipes     = [lastMsg.mes];
        lastMsg.swipe_id   = 0;
        lastMsg.swipe_info = [{
            send_date    : lastMsg.send_date,
            gen_started  : lastMsg.gen_started,
            gen_finished : lastMsg.gen_finished,
            extra        : JSON.parse(JSON.stringify(lastMsg.extra ?? {})),
        }];
    }

    // Snapshot the state we want to restore after generation finishes.
    const capturedState    = captureState(lastMsg, origSwipe);
    isBackgroundGenerating = true;

    // Build the freeze overlay before triggering generation so the user can
    // keep reading the current message while the new one streams underneath.
    const $lastMes  = $('#chat .last_mes');
    createFreezeOverlay($lastMes);

    // Keep the original button visible as the activity indicator.
    $lastMes.find(`.${BTN_CLASS}`).addClass('sp_btn_spinning');

    try {
        // Await the full swipe including SillyTavern's endSwipe() cleanup.
        // The new content streams into the hidden .mes_text; the MutationObserver
        // instantly restores the frozen HTML so the user reads the original message.
        // forceDuration:0 suppresses the slide-out / slide-in animation entirely.
        await ctx.swipe.to(null, SWIPE_DIRECTION.RIGHT, {
            source       : SWIPE_SOURCE.AUTO_SWIPE,
            forceSwipeId : lastMsg.swipes.length,   // force a new-generation slot
            forceDuration: 0,                        // no animation
        });
    } catch (err) {
        console.error('[SwipePregen] swipe.to failed:', err);
    } finally {
        $lastMes.find(`.${BTN_CLASS}`).removeClass('sp_btn_spinning');
        isBackgroundGenerating = false;
    }

    // Check whether a new swipe slot was actually created.
    const updatedMsg = ctx.chat[lastIdx];
    const newCount   = updatedMsg?.swipes?.length ?? 0;

    if (newCount > origCount) {
        // A new swipe was added.  Snap the view back to what the user was
        // reading (new swipe is accessible by swiping right).
        restoreState(updatedMsg, capturedState);
        // Stop the observer before re-rendering so addOneMessage can freely
        // update .mes_text with the original swipe content.
        removeOverlay();
        addOneMessage(updatedMsg, { type: 'swipe', forceId: lastIdx, showSwipes: true });
        refreshSwipeButtons(true);
        await saveChatConditional();
        if (!silent) toastr.success(t`Swipe ready! (${newCount} total)`, '', { timeOut: 2500 });
        return true;
    }

    // Nothing changed (generation cancelled / overswipe NONE / etc.) – clean up.
    removeOverlay();
    refreshSwipeButtons(true);
    return false;
}

// ─── Core: batch pre-generation ──────────────────────────────────────────────

/**
 * Pre-generate `count` swipes sequentially.
 * Displays a progress bar if the setting is enabled.
 *
 * @param {number} count  - Number of swipes to generate.
 */
async function runBatch(count) {
    if (!canStart()) {
        toastr.warning(t`Cannot start pre-generation – generation already in progress.`);
        return;
    }

    batchAbort = false;
    const settings = getSettings();

    if (settings.showProgressBar) showProgressBar(0, count);

    let completed = 0;
    for (let i = 0; i < count; i++) {
        if (batchAbort) break;

        const ok = await runBackgroundGeneration({ silent: true });
        if (!ok) break;

        completed++;
        if (settings.showProgressBar) showProgressBar(completed, count);

        // Brief pause to avoid hammering the API
        if (i < count - 1 && !batchAbort) {
            await new Promise(r => setTimeout(r, 300));
        }
    }

    if (settings.showProgressBar) removeProgressBar();

    if (completed > 0) {
        toastr.success(t`Pre-generation complete! Generated ${completed} swipe(s).`);
    }
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function showProgressBar(current, total) {
    let $bar = $(`#${PROGRESS_ID}`);
    if ($bar.length) {
        $bar.find('.sp_pb_current').text(current);
        $bar.find('.sp_pb_total').text(total);
        $bar.find('progress').val(current).attr('max', total);
        return;
    }

    $bar = $(`
        <div id="${PROGRESS_ID}" class="sp_progress_bar flex-container justifySpaceBetween alignItemsCenter">
            <div class="sp_pb_title">${t`Pre-generating swipes…`}</div>
            <div>(<span class="sp_pb_current">${current}</span>&thinsp;/&thinsp;<span class="sp_pb_total">${total}</span>)</div>
            <progress value="${current}" max="${total}" class="flex1"></progress>
            <button class="menu_button fa-solid fa-stop" title="${t`Stop pre-generation`}"></button>
        </div>
    `);

    $bar.find('button').on('click', () => {
        batchAbort = true;
        removeProgressBar();
    });

    // Insert before #chat inside the #sheld flex column so the bar sits
    // at the TOP of the chat area rather than below it.
    const $chatEl = $('#chat');
    if ($chatEl.length) {
        $chatEl.before($bar);
    } else {
        $('#sheld').prepend($bar);
    }
}

function removeProgressBar() {
    $(`#${PROGRESS_ID}`).remove();
}

// ─── Swipe-area button ────────────────────────────────────────────────────────

/**
 * (Re)inject the background-generate button into the swipeRightBlock of the
 * last message.  Safe to call multiple times – guards against duplicates.
 */
function refreshBgGenButton() {
    // Remove from any non-last message (happens after a new message arrives)
    $(`#chat .mes:not(.last_mes) .${BTN_CLASS}`).remove();

    const $lastMes = $('#chat .last_mes');
    if (!$lastMes.length) return;

    // Only show on non-user, non-system messages
    const ctx = getContext();
    if (!ctx?.chat?.length) return;
    const last = ctx.chat[ctx.chat.length - 1];
    if (!last || last.is_user || last.is_system) {
        $lastMes.find(`.${BTN_CLASS}`).remove();
        return;
    }

    if ($lastMes.find(`.${BTN_CLASS}`).length) return;  // already there

    const $btn = $(`<div class="${BTN_CLASS} fa-solid fa-forward" title="${t`Generate next swipe in background`}"></div>`);

    $btn.on('click', async (e) => {
        e.stopPropagation();
        if (isBackgroundGenerating || isGenerating()) {
            toastr.warning(t`A generation is already in progress.`);
            return;
        }
        await runBackgroundGeneration();
    });

    // Insert between the chevron and the swipes-counter for natural visual flow
    const $counter = $lastMes.find('.swipes-counter');
    if ($counter.length) {
        $counter.before($btn);
    } else {
        $lastMes.find('.swipeRightBlock').append($btn);
    }
}

// ─── Extensions-menu entry ────────────────────────────────────────────────────

function addExtensionsMenuEntry() {
    if ($('#sp_wand_entry').length) return;  // guard against double-injection

    const $entry = $(`
        <div id="sp_wand_entry" class="extension_container">
            <div class="list-group-item flex-container flexGap5 alignItemsCenter"
                 id="sp_wand_btn"
                 title="${t`Swipe pre-generation`}"
                 style="cursor:pointer;">
                <i class="fa-solid fa-forward fa-fw"></i>
                <span data-i18n="Swipe pre-generation">Swipe pre-generation</span>
            </div>
        </div>
    `);

    $entry.find('#sp_wand_btn').on('click', async (e) => {
        e.stopPropagation();
        $('#extensionsMenu').hide();
        await openPregenModal();
    });

    $('#extensionsMenu').append($entry);
}

// ─── Pre-generation modal ─────────────────────────────────────────────────────

async function openPregenModal() {
    const settings = getSettings();

    // Build the modal content as a jQuery object.  We keep a reference so we
    // can read the input values AFTER callGenericPopup resolves – the DOM nodes
    // may already have been removed from the document by then, but jQuery still
    // lets us read detached nodes.
    const $content = $(`
        <div class="sp_modal_content">
            <h3 style="margin-top:0;">${t`Swipe Pre-generation`}</h3>
            <hr>
            <div class="flex-container alignItemsCenter" style="gap:12px; margin-bottom:12px;">
                <label for="sp_batch_size" style="white-space:nowrap;">
                    ${t`Number of swipes to pre-generate:`}
                </label>
                <input id="sp_batch_size"
                       type="number"
                       min="1"
                       max="20"
                       value="${settings.defaultBatchSize}"
                       class="text_pole"
                       style="width:70px;">
            </div>
            <div class="flex-container alignItemsCenter" style="gap:8px; margin-bottom:8px;">
                <input type="checkbox"
                       id="sp_show_progress"
                       ${settings.showProgressBar ? 'checked' : ''}>
                <label for="sp_show_progress">${t`Show progress bar`}</label>
            </div>
        </div>
    `);

    const result = await callGenericPopup($content[0], POPUP_TYPE.CONFIRM, null, {
        okButton    : t`Start`,
        cancelButton: t`Cancel`,
    });

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        // Read values from our own cached jQuery reference – safe even if the
        // popup has already detached the nodes from the document.
        const countRaw            = parseInt($content.find('#sp_batch_size').val(), 10);
        const count               = isNaN(countRaw) || countRaw < 1 ? settings.defaultBatchSize : Math.min(countRaw, 20);
        settings.showProgressBar  = $content.find('#sp_show_progress').prop('checked');
        settings.defaultBatchSize = count;
        saveSettingsDebounced();
        runBatch(count);
    }
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

(function init() {
    const ctx = getContext();
    if (!ctx?.eventSource) {
        console.error('[SwipePregen] Could not get SillyTavern context.');
        return;
    }

    const { eventSource } = ctx;

    // Refresh the button whenever the message list changes
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => refreshBgGenButton());
    eventSource.on(event_types.USER_MESSAGE_RENDERED,      () => refreshBgGenButton());
    eventSource.on(event_types.MESSAGE_SWIPED,             () => refreshBgGenButton());
    eventSource.on(event_types.MESSAGE_DELETED,            () => refreshBgGenButton());
    eventSource.on(event_types.CHAT_LOADED,                () => refreshBgGenButton());

    // Clean up on chat switch
    eventSource.on(event_types.CHAT_CHANGED, () => {
        batchAbort = true;
        removeOverlay();
        removeProgressBar();
        isBackgroundGenerating = false;
    });

    // The Extensions-menu is appended to <body> lazily; poll briefly then add entry
    let _menuAttempts = 0;
    const tryAddMenuEntry = () => {
        if ($('#extensionsMenu').length) {
            addExtensionsMenuEntry();
        } else if (_menuAttempts++ < 20) {
            setTimeout(tryAddMenuEntry, 250);
        }
    };
    tryAddMenuEntry();

    // In case a chat is already loaded when this extension loads
    setTimeout(refreshBgGenButton, 500);

    console.log('[SwipePregen] Extension loaded.');
})();
