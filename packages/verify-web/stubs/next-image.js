/**
 * next/image stub — renders a plain <img> with the same props (no optimizer,
 * no loader, no placeholder blur). `next/image` does a lot of work at build
 * time (sizing, optimization, blur placeholders) that the sandbox can't
 * reproduce; we just want the image to render with the right src/alt so a
 * screenshot shows the image content.
 */
import React from 'react';

export default function Image({
  src,
  alt,
  width,
  height,
  fill: _fill,
  loader: _loader,
  placeholder: _placeholder,
  blurDataURL: _blurDataURL,
  priority: _priority,
  quality: _quality,
  sizes: _sizes,
  ...rest
}) {
  // Strip Next-specific props that don't belong on a plain <img>. Fold each
  // dimension into style independently so an image with only width (or only
  // height) still renders sized.
  const style = {
    ...(width != null ? { width } : {}),
    ...(height != null ? { height } : {}),
    ...rest.style,
  };
  return React.createElement('img', { src, alt, ...rest, style });
}
