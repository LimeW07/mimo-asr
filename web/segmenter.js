/**
 * 浏览器端音频分段器（替代服务端 ffmpeg）。
 * 目标：每段 base64 <= 10MB（官方限制），默认原始字节 <= 6.5MB。
 *
 * - WAV：解析 chunk 头，按 blockAlign 对齐切片，每段重建 RIFF 头（fmt 原样拷贝，兼容 PCM/Float/Extensible）
 * - MP3：跳过 ID3v2，按帧同步头定位分界点（校验相邻帧头），支持 CBR/VBR
 * - 小文件（不超过 maxBytes）：原样直传不分段
 *
 * 内存策略：只在生成某段时用 file.slice() 读取该段，超大文件不会整块进内存。
 */

export const MAX_B64_CHARS = 10_000_000;          // 官方 base64 上限
export const DEFAULT_MAX_BYTES = 6_500_000;       // 单段原始字节上限（b64 ≈ 8.67MB）
export const DEFAULT_TARGET_SECONDS = 240;

const MPEG1_BITRATES_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_BITRATES_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES = [
  [44100, 48000, 32000],   // MPEG1
  [22050, 24000, 16000],   // MPEG2
  [11025, 12000, 8000],    // MPEG2.5
];

export async function sniffFormat(file) {
  const head = new Uint8Array(await sliceRead(file, 0, 12));
  if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
      && head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45) {
    return "wav";
  }
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return "mp3";           // ID3v2
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return "mp3";                       // frame sync
  return null;
}

function sliceRead(file, start, len) {
  return file.slice(start, start + len).arrayBuffer();
}

/* ---------------- WAV ---------------- */

export async function parseWavHeader(file) {
  const buf = await sliceRead(file, 0, 12);
  const v = new DataView(buf);
  if (v.getUint32(0, false) !== 0x52494646) throw new Error("不是合法的 WAV（缺 RIFF）");
  if (v.getUint32(8, false) !== 0x57415645) throw new Error("不是合法的 WAV（缺 WAVE）");

  let offset = 12;
  let fmt = null;
  let data = null;
  const sub = new Uint8Array(8);

  while (offset + 8 <= file.size) {
    const head = new Uint8Array(await sliceRead(file, offset, 8));
    sub.set(head);
    const id = String.fromCharCode(head[0], head[1], head[2], head[3]);
    const size = new DataView(head.buffer, head.byteOffset).getUint32(4, true);
    if (id === "fmt ") {
      const n = Math.min(size, 4096);
      fmt = { offset: offset + 8, size, bytes: new Uint8Array(await sliceRead(file, offset + 8, n)) };
    } else if (id === "data") {
      data = { offset: offset + 8, size };
      break;
    }
    if (size === 0xffffffff) throw new Error("不支持 RF64/流式 WAV，请转为普通 WAV 或 mp3");
    offset += 8 + size + (size & 1);
  }

  if (!fmt || !data) throw new Error("WAV 缺少 fmt/data 块");
  if (fmt.bytes.length < 16) throw new Error("WAV fmt 块异常");
  const fv = new DataView(fmt.bytes.buffer, fmt.bytes.byteOffset, fmt.bytes.byteLength);
  const channels = fv.getUint16(2, true);
  const sampleRate = fv.getUint32(4, true);
  const byteRate = fv.getUint32(8, true);
  const blockAlign = fv.getUint16(12, true);
  if (!channels || !sampleRate || !byteRate || !blockAlign) throw new Error("WAV 头参数异常");
  if (data.offset + data.size > file.size + 1) {
    data.size = file.size - data.offset;   // 容错：截断文件
  }
  return { channels, sampleRate, byteRate, blockAlign, fmt, data };
}

export function planWavSegments(file, header, maxBytes = DEFAULT_MAX_BYTES, targetSeconds = DEFAULT_TARGET_SECONDS) {
  const targetBytes = Math.min(maxBytes, targetSeconds * header.byteRate);
  const step = Math.max(header.blockAlign, Math.floor(targetBytes / header.blockAlign) * header.blockAlign);
  const ranges = [];
  let start = header.data.offset;
  const end = header.data.offset + header.data.size;
  while (start < end) {
    const stop = Math.min(start + step, end);
    ranges.push({ start, stop });
    start = stop;
  }
  return ranges;
}

export async function readWavSegment(file, header, range) {
  const segLen = range.stop - range.start;
  const fmtTotal = 8 + header.fmt.size;
  const out = new Uint8Array(12 + fmtTotal + 8 + segLen);
  const v = new DataView(out.buffer);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  w(0, "RIFF");
  v.setUint32(4, 4 + fmtTotal + 8 + segLen, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, header.fmt.size, true);
  out.set(header.fmt.bytes.subarray(0, Math.min(header.fmt.size, header.fmt.bytes.length)), 20);
  const dataChunkAt = 20 + header.fmt.size;
  w(dataChunkAt, "data");
  v.setUint32(dataChunkAt + 4, segLen, true);
  const pcm = new Uint8Array(await sliceRead(file, range.start, segLen));
  out.set(pcm, dataChunkAt + 8);
  return out;
}

/* ---------------- MP3 ---------------- */

function parseFrameHeader(h, off) {
  const b0 = h[off], b1 = h[off + 1], b2 = h[off + 2];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0x03;      // 0=MPEG2.5 2=MPEG2 3=MPEG1 (1=reserved)
  const layerBits = (b1 >> 1) & 0x03;        // 1=LayerIII 2=LayerII 3=LayerI (0=reserved)
  if (versionBits === 1 || layerBits === 0) return null;
  const bitrateIdx = (b2 >> 4) & 0x0f;
  const srIdx = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null;
  if (layerBits !== 1) return null;          // 仅支持 Layer III（MP3）

  const mpegVersion = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const srTable = SAMPLE_RATES[versionBits === 3 ? 0 : versionBits === 2 ? 1 : 2];
  const sr = srTable[srIdx];
  const brTable = mpegVersion === 1 ? MPEG1_BITRATES_L3 : MPEG2_BITRATES_L3;
  const kbps = brTable[bitrateIdx];
  const samplesPerFrame = mpegVersion === 1 ? 1152 : 576;
  const frameLen = Math.floor((samplesPerFrame / 8) * kbps * 1000 / sr) + padding;
  if (frameLen < 24) return null;
  return { frameLen, kbps, sr, mpegVersion };
}

export async function mp3SkipId3(file) {
  const head = new Uint8Array(await sliceRead(file, 0, 10));
  if (!(head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33)) return 0;
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  const footer = (head[5] & 0x10) ? 10 : 0;
  return 10 + size + footer;
}

/** 从 from 开始找第一个合法帧头（用相邻帧交叉验证，避免假同步）。返回 {off, info} 或 null */
async function findFirstFrame(file, from) {
  const win = new Uint8Array(await sliceRead(file, from, Math.min(262144, file.size - from)));
  for (let i = 0; i + 4 <= win.length; i++) {
    const info = parseFrameHeader(win, i);
    if (!info) continue;
    const nextOff = i + info.frameLen;
    if (nextOff + 4 <= win.length) {
      const nxt = parseFrameHeader(win, nextOff);
      if (!nxt || nxt.frameLen !== info.frameLen) continue;
    } else if (from + nextOff >= file.size) {
      // 超出窗口/文件：文件尾最后一帧，接受
    } else {
      continue;   // 跨窗口无法验证，保守跳过（大窗口足够覆盖）
    }
    return { off: from + i, info };
  }
  return null;
}

/** 在 target 附近找最近的合法分界点（分界点必须是帧头且前后帧可验证） */
async function findFrameBoundary(file, target, first) {
  if (target <= first.off) return first.off;
  if (target >= file.size) return file.size;
  const W = 131072;
  const winStart = Math.max(first.off, target - W);
  const winLen = Math.min(W * 2, file.size - winStart);
  const win = new Uint8Array(await sliceRead(file, winStart, winLen));
  let best = null;
  for (let i = 0; i + 4 <= win.length; i++) {
    const info = parseFrameHeader(win, i);
    if (!info) continue;
    const nextOff = i + info.frameLen;
    const abs = winStart + i;
    let ok;
    if (nextOff + 4 <= win.length) {
      const nxt = parseFrameHeader(win, nextOff);
      ok = !!nxt;
    } else if (abs + info.frameLen >= file.size) {
      ok = true;   // 文件末帧
    } else {
      ok = false;  // 跨窗口边界：再读一段验证
      if (!ok) {
        try {
          const probe = new Uint8Array(await sliceRead(file, abs + info.frameLen, 4));
          ok = !!parseFrameHeader(probe, 0);
        } catch { ok = false; }
      }
    }
    if (!ok) continue;
    if (best === null || Math.abs(abs - target) < Math.abs(best - target)) best = abs;
    if (abs > target && best !== null) break;   // 递增扫描，越过 target 即可停止
  }
  return best;
}

export async function planMp3Segments(file, maxBytes = DEFAULT_MAX_BYTES, targetSeconds = DEFAULT_TARGET_SECONDS) {
  const from = await mp3SkipId3(file);
  const first = await findFirstFrame(file, from);
  if (!first) throw new Error("无法定位 MP3 音频帧（可能不是 MP3）");

  // 剥掉含 Xing/Info/VBRI 元数据的首帧（其帧数指向原文件整体，会导致时长/解码误判）
  let start = first.off;
  const fh = new Uint8Array(await sliceRead(file, first.off, Math.min(first.info.frameLen + 4, file.size - first.off)));
  const text = String.fromCharCode(...fh.subarray(0, Math.min(120, fh.length)));
  if (text.includes("Xing") || text.includes("Info") || text.includes("VBRI")) {
    const next = first.off + first.info.frameLen;
    if (next + 4 < file.size) {
      const probe = new Uint8Array(await sliceRead(file, next, 4));
      if (parseFrameHeader(probe, 0)) start = next;
    }
  }
  const anchor = { off: start };
  const targetBytes = Math.max(65536, Math.min(maxBytes, targetSeconds * (first.info.kbps * 1000 / 8)));

  const ranges = [];
  let cursor = start;
  while (cursor < file.size) {
    if (file.size - cursor <= targetBytes) {
      ranges.push({ start: cursor, stop: file.size });
      break;
    }
    const target = cursor + targetBytes;
    let stop = await findFrameBoundary(file, target, anchor);
    if (stop == null || stop <= cursor) stop = Math.min(file.size, cursor + targetBytes);
    if (stop < file.size) {
      const probe = new Uint8Array(await sliceRead(file, stop, 4));
      if (!parseFrameHeader(probe, 0)) {
        const alt = await findFrameBoundary(file, stop + 1, anchor);
        if (alt && alt > cursor && alt < file.size) stop = alt;
      }
    }
    if (stop <= cursor) stop = file.size;
    ranges.push({ start: cursor, stop });
    cursor = stop;
  }
  if (!ranges.length) ranges.push({ start, stop: file.size });
  return ranges;
}

export async function readMp3Segment(file, range) {
  return new Uint8Array(await sliceRead(file, range.start, range.stop - range.start));
}

/* ---------------- 统一入口 ---------------- */

export async function planSegments(file, opts = {}) {
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const targetSeconds = opts.targetSeconds || DEFAULT_TARGET_SECONDS;
  const format = await sniffFormat(file);
  if (format !== "wav" && format !== "mp3") {
    throw new Error("网页版仅支持 mp3 / wav；其他格式请用本地版（~/mimo-asr）");
  }
  if (format === "wav") {
    const header = await parseWavHeader(file);
    const passthrough = file.size <= maxBytes;
    return {
      format, passthrough, header,
      ranges: planWavSegments(file, header, maxBytes, targetSeconds),
    };
  }
  if (file.size <= maxBytes) {
    return { format, passthrough: true, ranges: [{ start: 0, stop: file.size }] };
  }
  return { format, passthrough: false, ranges: await planMp3Segments(file, maxBytes, targetSeconds) };
}

/** 读取任意范围（WAV 统一重建头；MP3 直传整文件或按范围切片） */
export async function readRange(plan, file, range) {
  if (plan.format === "wav") {
    if (!plan.header) plan.header = await parseWavHeader(file);
    return readWavSegment(file, plan.header, range);
  }
  const full = range.start === 0 && range.stop === file.size;
  if (plan.passthrough && full) return new Uint8Array(await sliceRead(file, 0, file.size));
  return new Uint8Array(await sliceRead(file, range.start, range.stop - range.start));
}

export async function readSegment(plan, file, index) {
  return readRange(plan, file, plan.ranges[index]);
}

export function segmentMime(plan) {
  if (plan.format === "mp3") return "audio/mpeg";
  return "audio/wav";
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function toDataUrl(bytes, mime) {
  return `data:${mime};base64,${arrayBufferToBase64(bytes)}`;
}

/** 把某个范围对半拆开（用于失败后的自适应拆分），返回 [rangeA, rangeB] 或 null */
export async function splitRange(plan, file, range) {
  if (range.stop - range.start < 32768) return null;
  const mid = Math.floor((range.start + range.stop) / 2);
  if (plan.format === "wav") {
    if (!plan.header) plan.header = await parseWavHeader(file);
    const align = plan.header.blockAlign;
    let m = Math.floor(mid / align) * align;
    if (m <= range.start || m >= range.stop) return null;
    return [{ start: range.start, stop: m }, { start: m, stop: range.stop }];
  }
  const anchor = await mp3SkipId3(file).then((from) => ({ off: from }));
  const b = await findFrameBoundary(file, mid, anchor);
  if (b == null || b <= range.start + 4096 || b >= range.stop - 4096) return null;
  return [{ start: range.start, stop: b }, { start: b, stop: range.stop }];
}
