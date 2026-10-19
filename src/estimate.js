/**
 * File-size estimates from a deliverable's codec settings, before anything
 * renders. Loaded by the Electron main process and the batcher (CommonJS) and
 * by the panel (window.ExportXEstimate), so the Settings form can show a size
 * while the editor changes the bit rate.
 *
 * How it counts:
 *   - a video with a bit rate set (VideoQuality in kb/s, what H.264/H.265 take):
 *     bit rate × seconds, the one case that is close to exact;
 *   - a video with a fixed-rate codec (ProRes, DNxHR, CineForm, uncompressed):
 *     the codec's published rate as bits per pixel per frame × pixels × frames;
 *   - a video on "automatic" quality: a typical rate for the codec, same arithmetic;
 *   - a still: bytes per pixel for the image format and bit depth (TIFF and DPX
 *     are exact, PNG/JPEG/EXR are typical compression);
 *   - audio: Linear PCM is channels × bit depth × sample rate; AAC and MP3 take
 *     Resolve's default data rate.
 * Every answer says which of these it used, so the panel can mark a typical
 * figure with "≈" and an exact one plainly.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ExportXEstimate = factory(); // eslint-disable-line no-param-reassign
})(typeof self !== 'undefined' ? self : this, function factory() {
  'use strict';

  /** Bits per pixel per frame for codecs whose rate the codec fixes (Apple ProRes white paper and Avid DNxHR tables, 1080p29.97 rates ÷ pixels per second). */
  const FIXED_BPP = [
    [/prores.*4444.*xq/i, 8.05, 'ProRes 4444 XQ'],
    [/prores.*4444/i, 5.31, 'ProRes 4444'],
    [/prores.*422.*hq|proreshq|prores_hq/i, 3.54, 'ProRes 422 HQ'],
    [/prores.*422.*lt|proreslt/i, 1.64, 'ProRes 422 LT'],
    [/prores.*proxy/i, 0.72, 'ProRes Proxy'],
    [/prores/i, 2.37, 'ProRes 422'],
    [/dnxhr.*444/i, 5.6, 'DNxHR 444'],
    [/dnxhr.*hqx/i, 3.5, 'DNxHR HQX'],
    [/dnxhr.*hq/i, 2.8, 'DNxHR HQ'],
    [/dnxhr.*sq/i, 1.85, 'DNxHR SQ'],
    [/dnxhr.*lb/i, 0.58, 'DNxHR LB'],
    [/dnxhd/i, 2.9, 'DNxHD'],
    [/cineform/i, 2.5, 'CineForm'],
    [/uncompressed|v210|r210|rgb ?10|^yuv/i, 20, 'uncompressed'],
    [/mjpeg|motion ?jpeg|photo ?jpeg/i, 2.5, 'Motion JPEG'],
  ];

  /** Typical rates Resolve's "Automatic" quality lands on for the long-GOP codecs, as bits per pixel per frame. */
  const AUTO_BPP = [
    [/h\.?265|hevc/i, 0.25, 'H.265'],
    [/h\.?264|avc|x264/i, 0.4, 'H.264'],
    [/av1/i, 0.2, 'AV1'],
    [/vp9/i, 0.25, 'VP9'],
    [/mpeg|xdcam|imx/i, 0.5, 'MPEG'],
  ];

  /** Bytes per pixel for one still frame, by format and bit depth. */
  const IMAGE_BYTES = {
    tif: { 8: 3, 16: 6, exact: true, name: 'TIFF' },
    tiff: { 8: 3, 16: 6, exact: true, name: 'TIFF' },
    dpx: { 8: 3, 10: 4, 16: 6, exact: true, name: 'DPX' },
    png: { 8: 1.6, 16: 3.5, exact: false, name: 'PNG' },
    jpg: { 8: 0.35, exact: false, name: 'JPEG' },
    jpeg: { 8: 0.35, exact: false, name: 'JPEG' },
    exr: { half: 3, float: 6, exact: false, name: 'EXR' },
    bmp: { 8: 3, exact: true, name: 'BMP' },
    tga: { 8: 3, exact: true, name: 'TGA' },
  };

  /** How Resolve's quality levels move a codec that has them, relative to High. */
  const LEVEL_SCALE = { Least: 0.3, Low: 0.5, Medium: 0.72, High: 1, Best: 1.5 };

  /** Resolve's default data rate for compressed audio, in kb/s. */
  const COMPRESSED_AUDIO_KBPS = 320;

  function isImageFormat(format) {
    return Object.prototype.hasOwnProperty.call(IMAGE_BYTES, String(format || '').toLowerCase());
  }

  function bitDepthOf(codec, settings) {
    const c = String(codec || '');
    const m = c.match(/(8|10|12|16|32)\s*bits?|rgba?\s*(8|10|12|16)|^(8|10|16)/i);
    if (m) return Number(m[1] || m[2] || m[3]);
    if (settings && Number(settings.BitDepth)) return Number(settings.BitDepth);
    return 8;
  }

  function levelScale(settings) {
    const q = settings ? settings.VideoQuality : undefined;
    if (typeof q === 'string' && LEVEL_SCALE[q]) return LEVEL_SCALE[q];
    return 1;
  }

  function audioBits(settings, seconds, channels) {
    if (!seconds) return 0;
    const codec = String((settings && settings.AudioCodec) || '').toLowerCase();
    if (codec === 'lpcm' || codec === 'pcm' || codec === 'linearpcm' || codec === 'wav') {
      const depth = Number(settings.AudioBitDepth) || 24;
      const rate = Number(settings.AudioSampleRate) || 48000;
      return channels * depth * rate * seconds;
    }
    return COMPRESSED_AUDIO_KBPS * 1000 * seconds;
  }

  /**
   * @param {object} job  { format, codec, settings, width, height, fps, frames, kind, channels }
   *   width/height: the output size (the deliverable's, else the timeline's); frames: how many the job renders
   * @returns {{ bytes: number|null, videoBytes: number, audioBytes: number, exact: boolean, basis: string }}
   */
  function estimateBytes(job) {
    const settings = (job && job.settings) || {};
    const width = Number(job.width) || 0;
    const height = Number(job.height) || 0;
    const fps = Number(job.fps) || 0;
    const frames = Number(job.frames) || 0;
    const pixels = width * height;
    const format = String(job.format || '').toLowerCase();
    const codec = String(job.codec || '');
    const exportVideo = settings.ExportVideo !== false;
    const exportAudio = settings.ExportAudio !== false && !isImageFormat(format) && job.kind !== 'still';
    if (!pixels || !frames) return { bytes: null, videoBytes: 0, audioBytes: 0, exact: false, basis: 'unknown size or length' };

    let videoBits = 0;
    let exact = true;
    let basis = '';
    if (!exportVideo) {
      basis = 'audio only';
    } else if (isImageFormat(format)) {
      const table = IMAGE_BYTES[format];
      let perPixel;
      if (format === 'exr') perPixel = /float|32/i.test(codec) ? table.float : table.half;
      else {
        const depth = bitDepthOf(codec, settings);
        perPixel = table[depth] || table[Object.keys(table).find((k) => /^\d+$/.test(k) && Number(k) >= depth) || 8] || table[8];
      }
      if (format === 'jpg' || format === 'jpeg') perPixel *= levelScale(settings);
      videoBits = perPixel * 8 * pixels * frames;
      exact = Boolean(table.exact);
      basis = `${table.name} at ${format === 'exr' ? (/float|32/i.test(codec) ? '32' : '16') : bitDepthOf(codec, settings)}-bit`;
    } else {
      const q = settings.VideoQuality;
      const kbps = typeof q === 'number' && q > 0 ? q : typeof q === 'string' && /^\d+$/.test(q) && Number(q) > 0 ? Number(q) : 0;
      const seconds = fps ? frames / fps : 0;
      if (kbps) {
        videoBits = kbps * 1000 * seconds;
        basis = `${kbps.toLocaleString('en-US')} kb/s`;
      } else {
        const fixed = FIXED_BPP.find(([re]) => re.test(codec));
        const auto = fixed || AUTO_BPP.find(([re]) => re.test(codec));
        const bpp = auto ? auto[1] : 0.4;
        videoBits = bpp * levelScale(settings) * pixels * frames;
        exact = false;
        basis = fixed ? `${fixed[2]} data rate` : `${auto ? auto[2] : codec || 'codec'} on automatic quality`;
      }
    }
    const seconds = fps ? frames / fps : 0;
    const audioBits2 = exportAudio ? audioBits(settings, seconds, Number(job.channels) || 2) : 0;
    const videoBytes = Math.round(videoBits / 8);
    const audioBytes = Math.round(audioBits2 / 8);
    const bytes = Math.round((videoBytes + audioBytes) * 1.01); // container overhead
    return { bytes, videoBytes, audioBytes, exact: exact && !(exportAudio && !/lpcm|pcm|wav/i.test(String(settings.AudioCodec || ''))), basis };
  }

  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '';
    if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB`;
    if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
    return `${bytes} B`;
  }

  /** "≈ 1.2 GB" for a typical figure, "1.2 GB" for an exact one. */
  function sizeLabel(est) {
    if (!est || est.bytes === null || est.bytes === undefined) return '';
    return `${est.exact ? '' : '≈ '}${formatBytes(est.bytes)}`;
  }

  return { estimateBytes, formatBytes, sizeLabel, isImageFormat, FIXED_BPP, AUTO_BPP, IMAGE_BYTES, LEVEL_SCALE, COMPRESSED_AUDIO_KBPS };
});
