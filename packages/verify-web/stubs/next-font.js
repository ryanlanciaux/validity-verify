/**
 * next/font stub — returns an empty className. next/font does its work at
 * build time (fetching fonts, generating CSS, computing class names); the
 * sandbox can't reproduce that. Components that apply a font className
 * render without the font but DO render (no crash).
 *
 * next/font/google and next/font/local both export a function that returns
 * an object with a `className` property. We stub both with the same shape.
 */
function makeFont() {
  return {
    className: '',
    variable: '',
    style: { fontFamily: '' },
  };
}

export default makeFont;
