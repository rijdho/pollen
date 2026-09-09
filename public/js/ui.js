// Element construction without markup. Every value that reaches the page goes
// through textContent or setAttribute, so a participant's answer can never be
// parsed as HTML no matter what they typed.

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    // Styles go through the CSSOM, never through a style attribute. Content
    // Security Policy does not govern element.style, so the policy in
    // public/_headers can refuse inline styles outright and still let the bars
    // and the word cloud size themselves.
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') throw new Error('markup is never inserted');
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  // Nothing falsy is ever appended. DOM append() stringifies its arguments, so
  // a conditional child written as `condition && node` puts a literal "false"
  // or "null" on the page rather than nothing, which is how "Sent.null" got as
  // far as a browser once.
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * append() that skips nothing-children, for the places that build a list of
 * nodes outside el(). Calling node.append(x) with a null or false puts the
 * word "null" on the page, and it has happened twice.
 */
export function appendAll(node, children) {
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function show(node, visible) {
  node.hidden = !visible;
}

/** A short-lived message in the page's one status region. */
export function status(node, message, kind = 'info') {
  node.textContent = message;
  node.dataset.kind = kind;
  node.hidden = message === '';
}
