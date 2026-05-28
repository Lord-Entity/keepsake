Third-party licences for the Keepsake Android app
==================================================

The files in this folder are verbatim copies of the licence texts of the
third-party programs and packages bundled in the Keepsake APK. They were
downloaded from the upstream sources listed below; nothing in them was edited.
YT-DLP-EJS.txt is the only file assembled from several texts: it joins three
upstream licence files, each preceded by one "=====" line naming its source.

These components keep their own licences. Keepsake's own licence (see the
LICENSE file in the Keepsake source repository) covers Keepsake's own code
only and places no restriction on them.

Keepsake runs FFmpeg and QuickJS-NG as separate programs
(lib/arm64-v8a/libffmpeg.so and lib/arm64-v8a/libqjs.so, started by yt-dlp
as child processes). It does not link to them.


FFMPEG-LGPL-2.1.txt
  FFmpeg 7.1.1, minimal build configured without --enable-gpl and without
  --enable-nonfree, so it is licensed under the GNU Lesser General Public
  License version 2.1 or later.
  Text from: https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1.1/COPYING.LGPLv2.1
  sha256 of this file: b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe
  Source code: tag n7.1.1 of https://github.com/FFmpeg/FFmpeg
               (release tarball: https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz)
  Release tarball sha256: 733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1
  Build script and configure flags: scripts/build-android-ffmpeg.sh in the
  Keepsake repository (NDK cross-build, same LGPL configure flags as
  https://github.com/Abdullah-Masood-05/ffmpeg-ytdl-minimal-build v1.1.0),
  recorded in the "android" block of scripts/binaries.lock.json.
  You may replace libffmpeg.so with your own build of FFmpeg by rebuilding
  the APK with it.

LAME-LGPL-2.0.txt
  LAME 3.100 (MP3 encoder), statically linked into the ffmpeg program.
  GNU Library General Public License version 2 or later.
  Text: the COPYING file of lame-3.100.tar.gz
        (tarball sha256 ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e;
         taken from https://deb.debian.org/debian/pool/main/l/lame/lame_3.100.orig.tar.gz,
         which has that same hash, and identical to tags/RELEASE__3_100/lame/COPYING
         in the LAME SourceForge svn)
  sha256 of this file: bfe4a52dc4645385f356a8e83cc54216a293e3b6f1cb4f79f5fc0277abf937fd
  Source code: https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz

OPUS-BSD-3.txt
  libopus 1.5.2 (Opus encoder), statically linked into the ffmpeg program.
  BSD 3-clause licence, plus the royalty-free patent licences it names.
  Text from: https://raw.githubusercontent.com/xiph/opus/v1.5.2/COPYING
  sha256 of this file: 01e1167d54a096d123cf6dfbbeb19587278845c6481d2d66d545669846079551
  Source code: https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz
               (sha256 65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1)

ZLIB.txt
  zlib. The desktop ffmpeg (ffmpeg-ytdl-minimal-build v1.1.0) configures
  --enable-zlib and links the build host's zlib statically (no pinned version).
  On Android, if the NDK build enables zlib, it links Android's own system
  libz.so, which is not shipped in the APK. The notice is included either way.
  zlib licence.
  Text from: https://raw.githubusercontent.com/madler/zlib/v1.3.1/LICENSE
  sha256 of this file: 845efc77857d485d91fb3e0b884aaa929368c717ae8186b66fe1ed2495753243
  Source code: https://github.com/madler/zlib

QUICKJS-NG-MIT.txt
  QuickJS-NG v0.18.0, the JavaScript runtime yt-dlp uses to solve YouTube's
  challenges. Shipped as libqjs.so, the upstream release asset
  qjs-linux-aarch64 renamed (or an NDK build of the same tag). MIT licence.
  Text from: https://raw.githubusercontent.com/quickjs-ng/quickjs/v0.18.0/LICENSE
  sha256 of this file: 96f73f9d2a16c21a36b418f06073be26e7d6d5e7c1bc99756b21a4f2c74ef171
  Source code: https://github.com/quickjs-ng/quickjs/releases/tag/v0.18.0

YT-DLP-EJS.txt
  yt-dlp-ejs 0.8.0 (Python package, the YouTube challenge solver scripts run
  by QuickJS-NG). Licence expression: Unlicense AND MIT AND ISC.
  Contents, in order:
    1. yt_dlp_ejs-0.8.0.dist-info/licenses/LICENSE from the PyPI wheel
       yt_dlp_ejs-0.8.0-py3-none-any.whl
       (wheel sha256 79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4)
       - the Unlicense.
    2. meriyah 6.1.4 (bundled in yt_dlp_ejs/yt/solver/lib.min.js), ISC:
       https://raw.githubusercontent.com/meriyah/meriyah/v6.1.4/LICENSE.md
    3. astring 1.9.0 (bundled in the same file), MIT:
       https://raw.githubusercontent.com/davidbonnet/astring/v1.9.0/LICENSE
  sha256 of this file: 01788c97f1d177808135fe52c6131f82fd66c47e4980f86468cfdf546ba3ac2d
  Source code: https://pypi.org/project/yt-dlp-ejs/0.8.0/ and https://github.com/yt-dlp/ejs


Not in this folder (unchanged from earlier releases): yt-dlp (Unlicense),
Chaquopy runtime (MIT), CPython 3.12 (PSF License), certifi (MPL-2.0).
See THIRD_PARTY_NOTICES.md in the Keepsake source repository for the full list.
