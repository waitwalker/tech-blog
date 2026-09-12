/**
 * 纯前端 Web Audio 程序化音频合成引擎
 * 零外部音频资源下载，通过高精度振荡器、滤波与增益包络原生合成 AAA 级游戏音效与动态电子音乐
 */

class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private isMuted = false;
  private bgmPlaying = false;
  private bgmTimer: number | null = null;
  private step = 0;
  private intensity: "calm" | "battle" | "boss" = "battle";

  private init() {
    if (this.ctx) return;
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.sfxGain = this.ctx.createGain();
      this.bgmGain = this.ctx.createGain();

      this.masterGain.gain.setValueAtTime(0.8, this.ctx.currentTime);
      this.sfxGain.gain.setValueAtTime(0.9, this.ctx.currentTime);
      this.bgmGain.gain.setValueAtTime(0.28, this.ctx.currentTime);

      this.sfxGain.connect(this.masterGain);
      this.bgmGain.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);
    } catch {
      /* ignore audio init failure on restrictive environments */
    }
  }

  public ensureContext() {
    this.init();
    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
  }

  public toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : 0.8, this.ctx.currentTime);
    }
    return this.isMuted;
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  public setIntensity(mode: "calm" | "battle" | "boss") {
    this.intensity = mode;
  }

  // ==========================
  // 1. 核心战斗音效 (SFX)
  // ==========================

  /** 脉冲连发枪音效：高频激光扫频 */
  public playPulseShoot() {
    this.ensureContext();
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(110, t + 0.08);

    gain.gain.setValueAtTime(0.22, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);

    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.08);
  }

  /** 等离子霰弹枪：低频重击 + 爆裂白噪音 */
  public playShotgunShoot() {
    this.ensureContext();
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const t = this.ctx.currentTime;

    // 低音轰鸣
    const osc = this.ctx.createOscillator();
    const oscGain = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(240, t);
    osc.frequency.exponentialRampToValueAtTime(35, t + 0.22);
    oscGain.gain.setValueAtTime(0.45, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(oscGain);
    oscGain.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.22);

    // 霰弹弹丸爆裂白噪音
    const bufferSize = Math.floor(this.ctx.sampleRate * 0.16);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1800, t);
    filter.frequency.exponentialRampToValueAtTime(300, t + 0.16);

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.35, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(this.sfxGain);
    noise.start(t);
  }

  /** 离子轨道炮：蓄力高鸣与穿透雷暴 */
  public playRailgunShoot() {
    this.ensureContext();
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const t = this.ctx.currentTime;

    // 蓄力刺耳电弧
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(2400, t + 0.15);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.45);

    gain.gain.setValueAtTime(0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);

    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.45);
  }

  /** 全向 EMP 脉冲：超重低音下潜震荡 */
  public playEmpBlast() {
    this.ensureContext();
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const t = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(450, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 0.8);

    gain.gain.setValueAtTime(0.65, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.8);

    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.8);
  }

  /** 命中反馈：清脆打击音 */
  public playHit() {
    this.ensureContext();
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.04);

    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.04);
  }

  /** 护盾防御受击音：金属全息嗡鸣 */
  public playShieldDeflect() {
    this.ensureContext();
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(2100, t);
    osc.frequency.linearRampToValueAtTime(1400, t + 0.12);

    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  /** 爆炸音效：根据是否为 BOSS 动态调整低通滤波与混响尾音 */
  public playExplosion(isBoss = false) {
    this.ensureContext();
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const t = this.ctx.currentTime;
    const dur = isBoss ? 1.2 : 0.45;

    const bufferSize = Math.floor(this.ctx.sampleRate * dur);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.4));
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(isBoss ? 450 : 850, t);
    filter.frequency.exponentialRampToValueAtTime(40, t + dur);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(isBoss ? 0.7 : 0.38, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxGain);
    noise.start(t);
  }

  /** 能量球拾取：上行清脆三度琶音 */
  public playPowerup() {
    this.ensureContext();
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 - E5 - G5 - C6
    notes.forEach((freq, idx) => {
      if (!this.ctx || !this.sfxGain) return;
      const t = this.ctx.currentTime + idx * 0.04;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + 0.1);
    });
  }

  /** 关卡胜利号角 */
  public playVictory() {
    this.ensureContext();
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const melody = [
      { f: 440, d: 0.12 },
      { f: 554.37, d: 0.12 },
      { f: 659.25, d: 0.16 },
      { f: 880, d: 0.45 },
    ];
    let offset = 0;
    melody.forEach((note) => {
      if (!this.ctx || !this.sfxGain) return;
      const t = this.ctx.currentTime + offset;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(note.f, t);
      gain.gain.setValueAtTime(0.35, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + note.d);
      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + note.d);
      offset += note.d * 0.9;
    });
  }

  // ==========================
  // 2. 自适应 Synthwave BGM 节拍引擎
  // ==========================

  public startBgm() {
    if (this.bgmPlaying) return;
    this.ensureContext();
    this.bgmPlaying = true;
    this.step = 0;
    this.scheduleBgmLoop();
  }

  public stopBgm() {
    this.bgmPlaying = false;
    if (this.bgmTimer) {
      window.clearTimeout(this.bgmTimer);
      this.bgmTimer = null;
    }
  }

  private scheduleBgmLoop() {
    if (!this.bgmPlaying || !this.ctx || !this.bgmGain) return;

    // 16 步进 D 小调贝斯音阶 (D1, F1, G1, A1)
    const baseNotes = [73.42, 73.42, 87.31, 73.42, 98.0, 73.42, 110.0, 73.42];
    const freq = baseNotes[this.step % baseNotes.length];
    const t = this.ctx.currentTime;

    // 1. 驱动贝斯
    const bassOsc = this.ctx.createOscillator();
    const bassGain = this.ctx.createGain();
    bassOsc.type = "sawtooth";
    bassOsc.frequency.setValueAtTime(freq, t);

    // 低通滤波带一点滤波扫频
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    const cutoff = this.intensity === "boss" ? 1400 : this.intensity === "battle" ? 800 : 450;
    filter.frequency.setValueAtTime(cutoff, t);
    filter.frequency.exponentialRampToValueAtTime(cutoff * 0.4, t + 0.11);

    bassGain.gain.setValueAtTime(0.22, t);
    bassGain.gain.exponentialRampToValueAtTime(0.001, t + 0.11);

    bassOsc.connect(filter);
    filter.connect(bassGain);
    bassGain.connect(this.bgmGain);
    bassOsc.start(t);
    bassOsc.stop(t + 0.12);

    // 2. 电子踩镲与鼓点 (逢 4 步产生军鼓白噪音)
    if (this.step % 4 === 2) {
      const snareBuffer = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * 0.08), this.ctx.sampleRate);
      const data = snareBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const snare = this.ctx.createBufferSource();
      snare.buffer = snareBuffer;
      const sGain = this.ctx.createGain();
      sGain.gain.setValueAtTime(this.intensity === "boss" ? 0.28 : 0.14, t);
      sGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      snare.connect(sGain);
      sGain.connect(this.bgmGain);
      snare.start(t);
    }

    this.step++;
    const tempoMs = this.intensity === "boss" ? 115 : 135; // 约 130~150 BPM
    this.bgmTimer = window.setTimeout(() => this.scheduleBgmLoop(), tempoMs);
  }
}

export const sound = new SoundEngine();
