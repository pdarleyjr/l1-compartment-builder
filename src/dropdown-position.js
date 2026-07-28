const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 4;
const SEARCH_HEIGHT = 44;
const MIN_LIST_HEIGHT = 120;
const MAX_LIST_HEIGHT = 256;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export function calculateDropdownPosition(triggerRect, visualViewport) {
  const viewport = visualViewport ?? {
    width: window.innerWidth,
    height: window.innerHeight,
    offsetTop: 0,
    offsetLeft: 0,
  };
  const viewportTop = viewport.offsetTop + VIEWPORT_MARGIN;
  const viewportBottom = viewport.offsetTop + viewport.height - VIEWPORT_MARGIN;
  const viewportLeft = viewport.offsetLeft + VIEWPORT_MARGIN;
  const viewportRight = viewport.offsetLeft + viewport.width - VIEWPORT_MARGIN;
  const width = Math.min(triggerRect.width, viewportRight - viewportLeft);
  const left = clamp(triggerRect.left, viewportLeft, viewportRight - width);
  const spaceBelow = viewportBottom - triggerRect.bottom - TRIGGER_GAP;
  const spaceAbove = triggerRect.top - TRIGGER_GAP - viewportTop;
  const preferredHeight = SEARCH_HEIGHT + MAX_LIST_HEIGHT;
  const minimumHeight = SEARCH_HEIGHT + MIN_LIST_HEIGHT;
  const placement = spaceBelow >= minimumHeight || spaceBelow >= spaceAbove ? 'below' : 'above';
  const availableHeight = Math.max(
    SEARCH_HEIGHT + 80,
    placement === 'below' ? spaceBelow : spaceAbove,
  );
  const listMaxHeight = Math.min(MAX_LIST_HEIGHT, availableHeight - SEARCH_HEIGHT);
  const height = Math.min(preferredHeight, SEARCH_HEIGHT + listMaxHeight);
  const top = placement === 'below'
    ? triggerRect.bottom + TRIGGER_GAP
    : Math.max(viewportTop, triggerRect.top - TRIGGER_GAP - height);

  return {
    placement,
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    listMaxHeight,
  };
}
