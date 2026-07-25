// ============================================================================
// 관측자(Cosmos Window) 테마 — 어두운 방의 창문 너머로 보이는 성운.
// 원본: "Cosmos Window (Standalone).html" 프로토타입을 ThemeBase 규약으로 이식.
//  - 성운은 WebGL 셰이더(fbm 도메인 워프 + 별 + 비네트)로 그린다.
//  - 공용 캔버스는 2D 컨텍스트라 WebGL을 직접 쓸 수 없으므로,
//    오프스크린 WebGL 캔버스에 렌더한 뒤 매 프레임 메인 캔버스에 합성한다.
//  - 소리 반응: 색은 톤 그레이딩 후 서서히 수렴, 큰 소리는 맥동(pulse),
//    지속음(rms>0.03가 2초 이상)은 성운 시간이 2배속 → 10초에 걸쳐 감쇠.
// ThemeBase 규약: constructor(canvas) / start() / onColor(data) / stop()
// ============================================================================
class CosmosWindowTheme {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.rafId = null;
        this.lastNow = null;
        this.gl = null;            // 오프스크린 WebGL 컨텍스트
        this.glCanvas = null;
        // 소리 상태 (원본 handleSound의 내부 상태)
        this.colorMain = [205 / 255, 95 / 255, 45 / 255];   // 현재 성운 색
        this.targetColor = [205 / 255, 95 / 255, 45 / 255]; // 수렴 목표 색
        this.bandTargets = null;                             // 3밴드 틴트 목표 (low/high)
        this.lowColor = [205 / 255, 95 / 255, 45 / 255];     // 저음 색 (EMA)
        this.highColor = [205 / 255, 95 / 255, 45 / 255];    // 고음 색 (EMA)
        this.pulseStart = 0;       // 큰 소리 맥동 시작 시각
        this.sustainUntil = 0;     // 지속음 2배속 유지 시한
        this.sustainDecayUntil = 0;// 지속음 감쇠 종료 시한
        this.simTime = 0;          // 성운 시뮬레이션 시간 (지속음이면 빨라짐)
        this.rmsHistory = [];      // 지속음 판정용 {t, rms}
        this.rim = new Array(11).fill(0.12);   // 창틀 칸별 림 라이트 밝기
        this.lastRimSampleAt = 0;  // 림 샘플링 스로틀 (160ms)
        this.statusText = "조용함 (대기)";
    }

    // ── 원본 셰이더 (그대로 이식) ──────────────────────────────────
    get 정점셰이더() {
        return "attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos,0.0,1.0); }";
    }
    get 조각셰이더() {
        return `
    precision mediump float;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform vec3 u_colorMain;
    uniform vec3 u_colorDust;
    uniform vec3 u_colorCore;
    uniform float u_pulse;
    float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
    float noise(vec2 p){
      vec2 i=floor(p); vec2 f=fract(p);
      float a=hash(i), b=hash(i+vec2(1.0,0.0)), c=hash(i+vec2(0.0,1.0)), d=hash(i+vec2(1.0,1.0));
      vec2 u=f*f*(3.0-2.0*f);
      return mix(a,b,u.x)+(c-a)*u.y*(1.0-u.x)+(d-b)*u.x*u.y;
    }
    float fbm(vec2 p){
      float v=0.0; float amp=0.5;
      for(int i=0;i<5;i++){ v+=amp*noise(p); p*=2.02; amp*=0.5; }
      return v;
    }
    vec2 warp(vec2 p, float t){
      vec2 q = vec2(fbm(p+t*0.02), fbm(p+vec2(5.2,1.3)-t*0.015));
      vec2 r = vec2(fbm(p+4.0*q+vec2(1.7,9.2)+t*0.01), fbm(p+4.0*q+vec2(8.3,2.8)-t*0.012));
      return r;
    }
    void main(){
      vec2 uv = gl_FragCoord.xy/u_resolution.xy;
      vec2 p = uv*3.0;
      float t = u_time;
      vec2 r = warp(p,t);
      float n = fbm(p+2.5*r);
      float core = smoothstep(0.35,0.85,n);
      core += u_pulse*0.3*smoothstep(0.5,0.9,n);
      vec3 col = mix(u_colorDust, u_colorMain, smoothstep(0.12,0.62,n));
      col = mix(col, u_colorCore, clamp(core,0.0,1.0));
      vec2 sp = uv*vec2(240.0,135.0);
      vec2 si = floor(sp);
      vec2 sf = fract(sp)-0.5;
      float sh = hash(si);
      float starMask = step(0.985, sh);
      float d2 = length(sf);
      float dot = smoothstep(0.45,0.0,d2)*starMask;
      float tw = 0.5+0.5*sin(t*2.0+sh*40.0);
      float starB = dot*tw*mix(0.3,1.0, smoothstep(0.2,0.8,n));
      col += vec3(starB)*0.95;
      float vig = smoothstep(0.95,0.3, distance(uv, vec2(0.5,0.45)));
      col *= mix(0.55,1.0, vig);
      gl_FragColor = vec4(col,1.0);
    }`;
    }

    /** 테마 활성화 — 오프스크린 WebGL 준비, 루프 시작 */
    start() {
        const W = this.canvas.width, H = this.canvas.height;
        this.ctx.clearRect(0, 0, W, H);
        this.simTime = 0;
        this.rmsHistory = [];
        this.rim = new Array(11).fill(0.12);
        this.lastNow = null;
        this.statusText = "조용함 (대기)";

        // 오프스크린 WebGL 캔버스 (창문 영역 크기)
        this.glCanvas = document.createElement("canvas");
        this.glCanvas.width = W;
        this.glCanvas.height = Math.round(H * 0.74);
        // preserveDrawingBuffer: 합성(drawImage)과 림 샘플(readPixels)이 다른 시점에도 안전하게
        const gl = this.glCanvas.getContext("webgl", { preserveDrawingBuffer: true });
        if (gl) {
            this.gl = gl;
            const 컴파일 = (src, type) => {
                const sh = gl.createShader(type);
                gl.shaderSource(sh, src);
                gl.compileShader(sh);
                if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(sh));
                return sh;
            };
            const prog = gl.createProgram();
            gl.attachShader(prog, 컴파일(this.정점셰이더, gl.VERTEX_SHADER));
            gl.attachShader(prog, 컴파일(this.조각셰이더, gl.FRAGMENT_SHADER));
            gl.linkProgram(prog);
            gl.useProgram(prog);
            const buf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER,
                new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
            const loc = gl.getAttribLocation(prog, "a_pos");
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
            this.u_res = gl.getUniformLocation(prog, "u_resolution");
            this.u_time = gl.getUniformLocation(prog, "u_time");
            this.u_main = gl.getUniformLocation(prog, "u_colorMain");
            this.u_dust = gl.getUniformLocation(prog, "u_colorDust");
            this.u_core = gl.getUniformLocation(prog, "u_colorCore");
            this.u_pulse = gl.getUniformLocation(prog, "u_pulse");
        } else {
            console.warn("WebGL 미지원 — 정적 배경으로 대체합니다");
        }

        const 루프 = (now) => {
            this.renderFrame(now);
            this.rafId = requestAnimationFrame(루프);
        };
        this.rafId = requestAnimationFrame(루프);
    }

    /** 새 색상 이벤트 — 원본 handleSound에 해당 (마이크 WebSocket 연결 지점).
        bands가 있으면 저음→성운 먼지(dust), 중음→본색(main), 고음→심(core) 틴트. */
    onColor(data) {
        const now = performance.now();
        this.rmsHistory.push({ t: now, rms: data.rms });
        while (this.rmsHistory.length && this.rmsHistory[0].t < now - 3000) this.rmsHistory.shift();
        // 온셋(타격)은 맥동으로 즉시 반응 — 색상 로직과 분리
        if (data.onset && data.onset.hit) this.onOnset(data.onset.strength, now);
        // strength: rms(대략 0~0.5)를 0~1 강도로 매핑 (0.7 초과 시 맥동)
        const strength = Math.min(1, data.rms * 3);
        const sustained = this.지속음인가(now);
        if (data.bands) {
            // 3밴드: 본색은 mid, 먼지/심 틴트는 low/high (톤 그레이딩 후 EMA 수렴)
            this.targetColor = this.톤보정(data.bands.mid.rgb);
            this.bandTargets = {
                low: this.톤보정(data.bands.low.rgb),
                high: this.톤보정(data.bands.high.rgb),
            };
        } else {
            this.targetColor = this.톤보정(data.rgb);   // 구버전 페이로드 폴백
            this.bandTargets = null;
        }
        if (strength > 0.7) this.pulseStart = now;               // 큰 소리 → 맥동
        if (sustained) {
            this.sustainUntil = now + 5000;                      // 5초 2배속
            this.sustainDecayUntil = now + 15000;                // 이후 10초 감쇠
        }
        this.renderFrame(now);   // rAF가 멈춘 비활성 탭에서도 갱신
    }

    /** 온셋(타격) — 성운이 순간 맥동 (기존 u_pulse 셰이더 재사용, 즉각적) */
    onOnset(strength, now) {
        if (strength >= 0.25) this.pulseStart = now;
    }

    /** 테마 비활성화 — 루프 정지, WebGL 자원 해제, 상태 리셋 */
    stop() {
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        this.rafId = null;
        if (this.gl) {
            const ext = this.gl.getExtension("WEBGL_lose_context");
            if (ext) ext.loseContext();   // GPU 컨텍스트 즉시 반납
        }
        this.gl = null;
        this.glCanvas = null;
        this.rmsHistory = [];
    }

    /** rms > 0.03 상태가 2초 이상 유지됐는지 (지속음 판정) */
    지속음인가(now) {
        if (this.rmsHistory.length < 6) return false;
        if (this.rmsHistory[0].t > now - 2000) return false;
        return this.rmsHistory.every(e => e.t < now - 2000 || e.rms > 0.03);
    }

    /** 입력색 톤 그레이딩: 채도 상한 + 밝기 클램프로 순색을 막아 장면 톤 유지 (원본 toneColor) */
    톤보정(rgb255) {
        const [r, g, b] = rgb255.map(v => v / 255);
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s = 0;
        const l = (max + min) / 2;
        const d = max - min;
        if (d !== 0) {
            s = d / (1 - Math.abs(2 * l - 1));
            if (max === r) h = ((g - b) / d) % 6;
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
            if (h < 0) h += 360;
        }
        s = Math.min(s, 0.5) * 0.85;
        const lC = Math.max(0.32, Math.min(0.58, l));
        const c = (1 - Math.abs(2 * lC - 1)) * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = lC - c / 2;
        let rr = 0, gg = 0, bb = 0;
        if (h < 60) { rr = c; gg = x; } else if (h < 120) { rr = x; gg = c; }
        else if (h < 180) { gg = c; bb = x; } else if (h < 240) { gg = x; bb = c; }
        else if (h < 300) { rr = x; bb = c; } else { rr = c; bb = x; }
        return [rr + m, gg + m, bb + m];
    }

    /** 0~1 RGB → #hex 문자열 */
    헥스(rgb01) {
        const to = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
        return "#" + to(rgb01[0]) + to(rgb01[1]) + to(rgb01[2]);
    }

    /** 한 프레임: 성운 렌더(WebGL) → 메인 캔버스 합성(창틀/반사/라벨) */
    renderFrame(now) {
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        const dtMs = this.lastNow === null ? 16.7 : Math.min(50, Math.max(0, now - this.lastNow));
        this.lastNow = now;
        const dt = dtMs / 1000;

        // ── 상태 갱신 (원본 loop 로직) ────────────────────────────
        let speedMul = 1;   // 지속음 속도 배수
        if (now < this.sustainUntil) speedMul = 2;
        else if (now < this.sustainDecayUntil) {
            const frac = (this.sustainDecayUntil - now) / 10000;
            speedMul = 1 + Math.max(0, Math.min(1, frac));
        }
        this.simTime += dt * speedMul;
        // 색 서서히 수렴 (급격한 교체 금지) — 밴드 색도 같은 속도로 수렴
        const k = 1 - Math.exp(-dt / 2.5);
        for (let i = 0; i < 3; i++) {
            this.colorMain[i] += (this.targetColor[i] - this.colorMain[i]) * k;
            if (this.bandTargets) {
                this.lowColor[i] += (this.bandTargets.low[i] - this.lowColor[i]) * k;
                this.highColor[i] += (this.bandTargets.high[i] - this.highColor[i]) * k;
            }
        }
        // 맥동 감쇠
        const pulseAge = (now - this.pulseStart) / 1500;
        const pulse = this.pulseStart ? Math.max(0, Math.exp(-Math.max(0, pulseAge) * 4)) : 0;

        // ── WebGL 성운 렌더 ───────────────────────────────────────
        const gl = this.gl;
        if (gl) {
            const main = this.colorMain;
            // 밴드 색이 있으면: 먼지는 저음 색, 심은 고음 색으로 은은하게 틴트
            const dust = this.bandTargets
                ? this.lowColor.map(v => v * 0.38)
                : main.map(v => v * 0.32);
            const 기본따뜻함 = [0.97, 0.92, 0.84];
            const warmWhite = this.bandTargets
                ? 기본따뜻함.map((w, i) => w * 0.72 + this.highColor[i] * 0.28)
                : 기본따뜻함;
            const core = main.map((v, i) => v * 0.4 + warmWhite[i] * 0.6);
            gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
            gl.uniform2f(this.u_res, gl.canvas.width, gl.canvas.height);
            gl.uniform1f(this.u_time, this.simTime);
            gl.uniform3f(this.u_main, main[0], main[1], main[2]);
            gl.uniform3f(this.u_dust, dust[0], dust[1], dust[2]);
            gl.uniform3f(this.u_core, core[0], core[1], core[2]);
            gl.uniform1f(this.u_pulse, pulse);
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            // 창틀 림 라이트 샘플링 (160ms 간격, 창 중앙 높이 11지점)
            if (now - this.lastRimSampleAt > 160) {
                this.lastRimSampleAt = now;
                const px = new Uint8Array(4);
                for (let i = 0; i < 11; i++) {
                    const x = Math.floor((i + 0.5) / 11 * gl.canvas.width);
                    const y = Math.floor(gl.canvas.height * 0.42);
                    try { gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); } catch (e) {}
                    this.rim[i] = Math.max(0.1, Math.min(1, (px[0] + px[1] + px[2]) / 540));
                }
                // 상태 라벨 갱신 (저빈도)
                if (this.pulseStart && pulseAge < 1) this.statusText = "큰 소리 감지 — 맥동";
                else if (now < this.sustainUntil) this.statusText = "지속음 유지 중";
                else if (now < this.sustainDecayUntil) this.statusText = "지속음 감쇠 중";
                else {
                    const diff = this.targetColor.reduce((a, v, i) => a + Math.abs(v - this.colorMain[i]), 0);
                    this.statusText = diff > 0.03 ? "소리 입력 확산 중" : "조용함 (대기)";
                }
            }
        }

        // ── 메인 캔버스 합성 ──────────────────────────────────────
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "#020202";
        ctx.fillRect(0, 0, W, H);

        const 창위 = H * 0.06, 창높이 = H * 0.74;          // 창문(성운) 영역
        const 큰칸아래 = H * 0.68, 가로대아래 = H * 0.73;  // 큰 창칸 / 가로대 경계
        const 바닥위 = H * 0.80;                            // 바닥(반사) 시작

        // 성운 (창문 너머)
        if (gl) {
            ctx.drawImage(this.glCanvas, 0, 창위, W, 창높이);
        } else {
            ctx.fillStyle = "#1a0f14";   // WebGL 미지원 시 정적 배경
            ctx.fillRect(0, 창위, W, 창높이);
        }

        // 바닥 + 성운 반사 (뒤집어 그리고 블러, 이후 창틀이 위에 덮임)
        ctx.fillStyle = "#050403";
        ctx.fillRect(0, 바닥위, W, H - 바닥위);
        if (gl) {
            ctx.save();
            ctx.globalAlpha = 0.27;
            ctx.filter = "blur(3px)";
            ctx.translate(0, H);
            ctx.scale(1, -1);
            ctx.drawImage(this.glCanvas,
                0, this.glCanvas.height * 0.06, this.glCanvas.width, this.glCanvas.height * 0.55,
                0, 0, W, H - 바닥위);
            ctx.restore();
        }
        // 바닥 타일 줄눈 (은은한 격자)
        ctx.strokeStyle = "rgba(255,255,255,0.05)";
        ctx.lineWidth = 1;
        for (let y = 바닥위 + 21; y < H; y += 21) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }
        for (let x = 48; x < W; x += 96) {
            ctx.beginPath(); ctx.moveTo(x, 바닥위); ctx.lineTo(x, H); ctx.stroke();
        }

        // 상단 어두운 띠
        const 띠 = ctx.createLinearGradient(0, 0, 0, 창위);
        띠.addColorStop(0, "#000000");
        띠.addColorStop(1, "#0a0806");
        ctx.fillStyle = 띠;
        ctx.fillRect(0, 0, W, 창위);

        // 창틀 (11칸): 세로 멀리언 + 위/아래 테두리 + 가로대
        const 칸폭 = W / 11;
        ctx.fillStyle = "#0a0806";
        ctx.fillRect(0, 창위, W, 8);                       // 큰 칸 상단 테두리
        ctx.fillRect(0, 큰칸아래, W, 가로대아래 - 큰칸아래); // 가운데 가로대
        ctx.fillRect(0, H * 0.80 - 6, W, 6);               // 작은 칸 하단 테두리
        for (let i = 0; i <= 11; i++) {
            const x = i * 칸폭;
            ctx.fillRect(x - 5, 창위, 10, 바닥위 - 창위);   // 세로 멀리언 (10px)
        }
        // 가로대 입체감
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(0, 큰칸아래, W, 3);
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(0, 가로대아래 - 1, W, 1);

        // 칸별 림 라이트 (성운 밝기를 창틀 안쪽 유리에 비침)
        const [r255, g255, b255] = this.colorMain.map(v => Math.round(v * 255));
        for (let i = 0; i < 11; i++) {
            const br = this.rim[i];
            const x = i * 칸폭 + 5;
            const w = 칸폭 - 10;
            // 큰 칸
            ctx.strokeStyle = `rgba(${r255},${g255},${b255},${(0.10 + 0.22 * br).toFixed(3)})`;
            ctx.lineWidth = 6;
            ctx.strokeRect(x + 3, 창위 + 8 + 3, w - 6, 큰칸아래 - 창위 - 8 - 6);
            ctx.strokeStyle = `rgba(${r255},${g255},${b255},${(0.30 + 0.35 * br).toFixed(3)})`;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x + 0.75, 창위 + 8 + 0.75, w - 1.5, 큰칸아래 - 창위 - 8 - 1.5);
            // 작은 칸
            ctx.strokeStyle = `rgba(${r255},${g255},${b255},${(0.16 + 0.28 * br).toFixed(3)})`;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x + 0.75, 가로대아래 + 0.75, w - 1.5, H * 0.80 - 6 - 가로대아래 - 1.5);
        }

        // 타이틀 + 상태 라벨
        ctx.font = "9px ui-monospace, Menlo, monospace";
        ctx.fillStyle = "rgba(255,255,255,0.26)";
        ctx.fillText("Sound to Color — Cosmos Window", 12, 14);
        const 라벨 = `${this.헥스(this.colorMain)}  ·  ${this.statusText}`;
        ctx.font = "10px ui-monospace, Menlo, monospace";
        const 라벨폭 = ctx.measureText(라벨).width;
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(8, H - 26, 라벨폭 + 16, 18);
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fillText(라벨, 16, H - 13);
    }
}
