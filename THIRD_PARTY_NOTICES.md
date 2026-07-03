# Third-party software notices

Deez VRM Viewer includes open-source components. Their licences apply to the
components themselves; they do not make the original App code open source.
Versions reflect the production dependency tree installed on 3 July 2026.

## Bundled preview motion data

The keyframe data authored in `src/viewer/ViewerController.ts` for **Gentle
idle**, **Friendly wave**, **Walk in place**, and **Polite bow** is dedicated
to the public domain under [Creative Commons Zero
1.0](https://creativecommons.org/publicdomain/zero/1.0/). It may be copied,
modified, redistributed, and used commercially without attribution.

These deliberately small diagnostic motions are bundled as readable code
rather than opaque binary assets. The
[Quaternius Universal Animation Library 2](https://quaternius.com/packs/universalanimationlibrary2.html)
is linked as an optional CC0 source but is not redistributed with this App.
Users should retain the licence information supplied with any animation they
import.

| Component | Version | Licence | Copyright / project |
|---|---:|---|---|
| `@pixiv/three-vrm` | 3.5.4 | MIT | © 2019–2026 pixiv Inc. |
| `@pixiv/three-vrm-animation` | 3.5.4 | MIT | © 2019–2026 pixiv Inc. |
| `@preact/signals` | 2.9.2 | MIT | © 2022–present Preact Team |
| `preact` | 10.29.3 | MIT | © 2015–present Jason Miller |
| `three` | 0.180.0 | MIT | © 2010–2025 three.js authors |
| `lucide-preact` | 0.468.0 | ISC | Lucide Contributors; Feather portions © Cole Bemis |

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the “Software”), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ISC License (Lucide)

Copyright (c) for portions of Lucide are held by Cole Bemis 2013–2022 as part
of Feather (MIT). All other copyright (c) for Lucide are held by Lucide
Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED “AS IS” AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
