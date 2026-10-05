import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { planSegments, readSegment, splitRange, sniffFormat, toDataUrl, segmentMime } =
  await import(new URL("../segmenter.js", import.meta.url));

const here = dirname(fileURLToPath(import.meta.url));
let dir;

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "pipe" });
}

function probe(file) {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-show_entries", "stream=codec_name,channels,sample_rate",
    "-of", "json", file,
  ], { stdio: "pipe" }).toString();
  return JSON.parse(out);
}

before(() => {
  if (!existsSync("ffmpeg") && !existsSync("/usr/bin/ffmpeg")) {
    try { execSync("ffmpeg -version", { stdio: "pipe" }); }
    catch { console.error("ffmpeg required"); process.exit(1); }
  }
  dir = mkdtempSync(join(tmpdir(), "segtest-"));
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=600", "-ar", "16000", "-ac", "1", join(dir, "mono600.wav")]);
  ffmpeg(["-f", "lavfi", "-i", "anoisesrc=d=300", "-ar", "44100", "-ac", "2", join(dir, "stereo300.wav")]);
  ffmpeg(["-f", "lavfi", "-i", "anoisesrc=d=600", "-c:a", "libmp3lame", "-b:a", "128k", join(dir, "cbr600.mp3")]);
  ffmpeg(["-f", "lavfi", "-i", "anoisesrc=d=400", "-c:a", "libmp3lame", "-q:a", "4", join(dir, "vbr400.mp3")]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "16000", "-ac", "1", join(dir, "small.wav")]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", "-b:a", "128k", join(dir, "small.mp3")]);
  writeFileSync(join(dir, "fake.aac"), Buffer.from("not an audio file, just ftyp-ish"));
});

async function planAndRead(name, opts) {
  const path = join(dir, name);
  const file = new File([await import("node:fs/promises").then(fs => fs.readFile(path))], name);
  const plan = await planSegments(file, opts);
  const segments = [];
  for (let i = 0; i < plan.ranges.length; i++) {
    segments.push(await readSegment(plan, file, i));
  }
  return { file, plan, segments, path };
}

function assertRangesContiguous(plan, file) {
  const rs = plan.ranges;
  assert.ok(rs.length >= 1);
  for (let i = 0; i + 1 < rs.length; i++) {
    assert.equal(rs[i].stop, rs[i + 1].start, `range ${i} 不连续`);
  }
  assert.ok(rs[0].start >= 0 && rs[rs.length - 1].stop <= file.size, "范围越界");
  if (!plan.passthrough && plan.format === "mp3") {
    assert.ok(rs[0].start >= 10, "mp3 分段应跳过 ID3");
  }
}

test("小文件直传（passthrough）", async () => {
  for (const name of ["small.wav", "small.mp3"]) {
    const { plan, segments } = await planAndRead(name);
    assert.equal(plan.passthrough, true, name);
    assert.equal(segments.length, 1);
    const dataUrl = toDataUrl(segments[0], segmentMime(plan));
    assert.ok(dataUrl.startsWith("data:audio/"));
    assert.ok(dataUrl.length <= 10_000_000);
  }
});

test("非 mp3/wav 拒绝", async () => {
  const file = new File([Buffer.from("ftypisomfake")], "x.m4a");
  await assert.rejects(() => planSegments(file), /仅支持 mp3/);
});

test("WAV 大文件分段：连续、等长、字节精确、ffprobe 合法", async () => {
  const { plan, file, segments, path } = await planAndRead("mono600.wav", { maxBytes: 6_500_000 });
  assert.equal(plan.passthrough, false);
  assert.equal(plan.format, "wav");
  assertRangesContiguous(plan, file);
  assert.ok(segments.length >= 2, `应多段，实际 ${segments.length}`);

  // 每段 <= maxBytes（含头部开销容忍 +128）
  for (const seg of segments) assert.ok(seg.length <= 6_500_128, `段过大 ${seg.length}`);

  // 写盘 + ffprobe
  const concatPcm = [];
  segments.forEach((seg, i) => {
    const p = join(dir, `out_mono_${i}.wav`);
    writeFileSync(p, seg);
    const pr = probe(p);
    assert.equal(pr.streams[0].codec_name, "pcm_s16le");
    assert.equal(String(pr.streams[0].channels), "1");
    // 提取 data 块
    const view = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
    let off = 12;
    while (off + 8 <= seg.byteLength) {
      const id = String.fromCharCode(seg[off], seg[off + 1], seg[off + 2], seg[off + 3]);
      const size = view.getUint32(off + 4, true);
      if (id === "data") { concatPcm.push(seg.subarray(off + 8, off + 8 + size)); break; }
      off += 8 + size + (size & 1);
    }
  });

  // 与原始 data 块逐字节一致
  const original = Buffer.from(await import("node:fs/promises").then(fs => fs.readFile(path)));
  const ov = new DataView(original.buffer, original.byteOffset, original.byteLength);
  let oOff = 12, origData = null;
  while (oOff + 8 <= original.length) {
    const id = original.toString("ascii", oOff, oOff + 4);
    const size = ov.getUint32(oOff + 4, true);
    if (id === "data") { origData = original.subarray(oOff + 8, oOff + 8 + size); break; }
    oOff += 8 + size + (size & 1);
  }
  const joined = Buffer.concat(concatPcm);
  assert.equal(joined.length, origData.length, "PCM 总长不一致");
  assert.ok(joined.equals(origData), "PCM 内容不一致");
});

test("WAV 立体声 44.1k 分段", async () => {
  const { plan, file, segments } = await planAndRead("stereo300.wav", { maxBytes: 6_500_000 });
  assert.ok(segments.length >= 8, `段数 ${segments.length}`);
  assertRangesContiguous(plan, file);
  segments.forEach((seg, i) => {
    const p = join(dir, `out_st_${i}.wav`);
    writeFileSync(p, seg);
    const pr = probe(p);
    assert.equal(String(pr.streams[0].channels), "2");
    assert.equal(String(pr.streams[0].sample_rate), "44100");
  });
});

test("MP3 CBR 分段：每段 ffprobe 可解析且时长守恒", async () => {
  const { plan, file, segments, path } = await planAndRead("cbr600.mp3", { maxBytes: 6_500_000, targetSeconds: 240 });
  assert.equal(plan.format, "mp3");
  assert.ok(segments.length >= 2, `段数 ${segments.length}`);
  assertRangesContiguous(plan, file);

  let sum = 0;
  segments.forEach((seg, i) => {
    const p = join(dir, `out_cbr_${i}.mp3`);
    writeFileSync(p, seg);
    const pr = probe(p);
    assert.equal(pr.streams[0].codec_name, "mp3", `段 ${i} 非 mp3`);
    sum += parseFloat(pr.format.duration);
  });
  const orig = parseFloat(probe(path).format.duration);
  assert.ok(Math.abs(sum - orig) < 3, `时长守恒失败: ${sum} vs ${orig}`);
});

test("MP3 VBR 分段", async () => {
  const { plan, segments } = await planAndRead("vbr400.mp3", { maxBytes: 6_500_000, targetSeconds: 240 });
  assert.ok(segments.length >= 1);
  segments.forEach((seg, i) => {
    const p = join(dir, `out_vbr_${i}.mp3`);
    writeFileSync(p, seg);
    assert.equal(probe(p).streams[0].codec_name, "mp3");
  });
});

test("小 maxBytes 压力：多段边界全部合法", async () => {
  const { plan, file, segments } = await planAndRead("cbr600.mp3", { maxBytes: 200_000, targetSeconds: 8 });
  assert.ok(segments.length >= 20, `段数 ${segments.length}`);
  assertRangesContiguous(plan, file);
  for (let i = 0; i < segments.length; i++) {
    const p = join(dir, `out_stress_${i}.mp3`);
    writeFileSync(p, segments[i]);
    const pr = probe(p);
    assert.equal(pr.streams[0].codec_name, "mp3", `段 ${i} 损坏`);
  }
});

test("splitRange：WAV 对半拆分仍合法", async () => {
  const { plan, file, path } = await planAndRead("mono600.wav", { maxBytes: 6_500_000 });
  const mid = plan.ranges[1];
  const halves = await splitRange(plan, file, mid);
  assert.ok(halves && halves.length === 2);
  assert.equal(halves[0].start, mid.start);
  assert.equal(halves[1].stop, mid.stop);
  for (const [i, r] of halves.entries()) {
    const bytes = await readSegment({ ...plan, ranges: [r] }, file, 0);
    const p = join(dir, `out_split_${i}.wav`);
    writeFileSync(p, bytes);
    assert.equal(probe(p).streams[0].codec_name, "pcm_s16le");
  }
  void path;
});

test("splitRange：MP3 拆分点必须是合法帧起点", async () => {
  const { plan, file } = await planAndRead("cbr600.mp3", { maxBytes: 6_500_000, targetSeconds: 240 });
  const mid = plan.ranges[Math.floor(plan.ranges.length / 2)];
  const halves = await splitRange(plan, file, mid);
  assert.ok(halves && halves.length === 2);
  for (const [i, r] of halves.entries()) {
    const bytes = await readSegment({ ...plan, ranges: [r] }, file, 0);
    const p = join(dir, `out_msplit_${i}.mp3`);
    writeFileSync(p, bytes);
    assert.equal(probe(p).streams[0].codec_name, "mp3", `半段 ${i} 非法`);
  }
});

test("sniffFormat", async () => {
  assert.equal(await sniffFormat(new File([Buffer.from("RIFF....WAVE")], "a.wav")), "wav");
  assert.equal(await sniffFormat(new File([Buffer.from([0x49, 0x44, 0x33, 0])], "a.mp3")), "mp3");
  assert.equal(await sniffFormat(new File([Buffer.from([0xff, 0xfb, 0x90, 0x00])], "a.mp3")), "mp3");
  assert.equal(await sniffFormat(new File([Buffer.from("xxxx")], "a.bin")), null);
});

test.after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
