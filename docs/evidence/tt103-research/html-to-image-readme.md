Retrieved README evidence excerpts (line numbers from retrieved upstream README; not runtime implementation).

310: - SVG `<foreignObject>` tag
314: *Internet Explorer is not (and will not be) supported, as it does not support SVG `<foreignObject>` tag.*
320: This library uses a feature of SVG that allows having arbitrary HTML content inside of the `<foreignObject>` tag. So, in order to render that DOM node for you, following steps are taken:
334: 6. Wrap XML into the `<foreignObject>` tag, then into the SVG, then make it a data URL
341: - If the DOM node you want to render includes a `<canvas>` element with something drawn on it, it should be handled fine, unless the canvas is [tainted](https://developer.mozilla.org/en-US/docs/Web/HTML/CORS_enabled_image) - in this case rendering will rather not succeed.
