# @validity.ai/verify-plugin-next

`next.config` wrapper that writes `.validity/app-manifest.json`. Your config
object is returned unchanged.

```js
import { withValidity } from '@validity.ai/verify-plugin-next';

export default withValidity({
  reactStrictMode: true,
});
```

Run `next dev` once. Commit the manifest.
