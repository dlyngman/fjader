/**
 * Pointer modifiers by platform. A Mac and the others disagree on Ctrl: on a
 * Mac, Ctrl+click is a right click (it opens the context menu) and Cmd adds to
 * a selection; elsewhere Ctrl adds to a selection.
 */

/** Whether this is a Mac (or an iPad or iPhone, which follow its modifiers). */
export const isMac: boolean =
	typeof navigator !== 'undefined' &&
	/Mac|iPhone|iPad/i.test(
		(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
			navigator.platform ??
			''
	);

/**
 * A click that adds to a selection rather than replacing it: Shift, or Cmd on
 * a Mac and Ctrl elsewhere. `mac` is for tests.
 */
export function isMultiSelect(event: MouseEvent, mac: boolean = isMac): boolean {
	return event.shiftKey || (mac ? event.metaKey : event.ctrlKey);
}

/**
 * A press that opens the context menu rather than pressing: any button but
 * the primary one, or Ctrl with it on a Mac. `mac` is for tests.
 */
export function isContextPress(event: PointerEvent, mac: boolean = isMac): boolean {
	return event.button !== 0 || (mac && event.ctrlKey);
}
