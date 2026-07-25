// ============================================================================
// 복셀 파동(Voxel Wave Field) 테마 — 120x120 복셀 기둥 필드에 소리가 파동으로 퍼짐.
// 원본: "Voxel Wave Field (standalone).html" 프로토타입을 ThemeBase 규약으로 이식.
//  - three.js InstancedMesh + UnrealBloom 이중 컴포저 (static/vendor/three-stack-*.js)
//  - 공용 캔버스는 2D 컨텍스트라, 오프스크린 캔버스에 three.js로 렌더한 뒤
//    매 프레임 메인 캔버스에 drawImage로 합성한다 (코스모스 창과 같은 방식)
//  - 소리 → 파동 링 1개(700ms 스로틀), 큰 소리 → 제자리 스플래시,
//    지속음 → 필드 전체가 소리 색으로 물듦(틴트), 끝나면 8초에 걸쳐 복귀
// ThemeBase 규약: constructor(canvas) / start() / onColor(data) / stop()
// ============================================================================
class VoxelWaveTheme {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.rafId = null;
        this.rmsHistory = [];    // 지속음 판정용 {t, rms}
        this.lastWaveAt = 0;     // 파동 스폰 스로틀 (원본 지속음 간격과 같은 700ms)
        this.lastSplashAt = 0;   // 스플래시 스로틀
        this.renderer = null;    // three.js 자원 (stop에서 해제)
        this.lastHex = "#000000";
    }

    /** 테마 활성화 — three.js 씬 구성, 루프 시작 */
    start() {
        const W = this.canvas.width, H = this.canvas.height;
        this.ctx.clearRect(0, 0, W, H);
        this.rmsHistory = [];
        this.waves = [];
        this.tintAmount = 0;
        this.tintTarget = 0;
        this.tintColor = [0.09, 0.065, 0.16];

        const THREE = window.THREE;
        if (!THREE || !THREE.UnrealBloomPass) {
            // three.js 스택이 로드되지 않은 환경 — 안내만 그리고 종료 (크래시 방지)
            this.ctx.fillStyle = "#0a0e1c";
            this.ctx.fillRect(0, 0, W, H);
            this.ctx.fillStyle = "rgba(216,212,236,0.6)";
            this.ctx.font = "12px ui-monospace, monospace";
            this.ctx.fillText("three.js 로드 실패 — 복셀 파도 테마를 사용할 수 없습니다", 20, H / 2);
            console.warn("VoxelWaveTheme: window.THREE 미존재");
            return;
        }
        this.THREE = THREE;

        // ---- 필드 설정 (원본 그대로) ----
        const N = 120, SPACING = 0.85, CUBE = 0.7;
        this.N = N;
        this.fieldHalf = (N * SPACING) / 2;
        this.DARK = [0.09, 0.065, 0.16];     // #1a1230 근처
        this.LIGHT = [0.27, 0.20, 0.47];     // #4a3585 근처
        this.WHITE = [1, 1, 1];
        this.LAVENDER = [0.847, 0.831, 0.925];

        const count = N * N;
        this.count = count;
        this.baseHash = new Float32Array(count);
        this.variantHash = new Float32Array(count);
        this.flickerPhase = new Float32Array(count);
        this.gx = new Float32Array(count);
        this.gz = new Float32Array(count);
        let n = 0;
        for (let i = 0; i < N; i++) {
            for (let j = 0; j < N; j++) {
                this.baseHash[n] = this.해시(i * 0.31, j * 0.71);
                this.variantHash[n] = this.해시(i * 1.7 + 5, j * 1.3 + 9);
                this.flickerPhase[n] = this.해시(i * 3.1 + 2, j * 5.9 + 1) * 300;
                this.gx[n] = (i - N / 2) * SPACING;
                this.gz[n] = (j - N / 2) * SPACING;
                n++;
            }
        }

        this.geometry = new THREE.BoxGeometry(CUBE, 1, CUBE);
        // 참고(원본 주석): InstancedMesh 내장 instanceColor 경로가 검정으로 렌더되는
        // 문제가 있어 커스텀 ShaderMaterial + InstancedBufferAttribute로 색을 직접 배선
        this.instColorAttr = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
        this.geometry.setAttribute("instColor", this.instColorAttr);
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                fogColor: { value: new THREE.Color(0x0a0e1c) },
                fogDensity: { value: 0.020 },
                lightDir: { value: new THREE.Vector3(0.2, 0.92, 0.32).normalize() },
            },
            vertexShader: `
        attribute vec3 instColor;
        varying vec3 vColor;
        varying vec3 vNormalW;
        varying float vDist;
        void main() {
          vColor = instColor;
          vec4 worldPos = instanceMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(instanceMatrix) * normal);
          vec4 mvPosition = modelViewMatrix * worldPos;
          vDist = -mvPosition.z;
          gl_Position = projectionMatrix * mvPosition;
        }`,
            fragmentShader: `
        uniform vec3 fogColor;
        uniform float fogDensity;
        uniform vec3 lightDir;
        varying vec3 vColor;
        varying vec3 vNormalW;
        varying float vDist;
        void main() {
          float diff = 0.55 + 0.45 * max(dot(normalize(vNormalW), lightDir), 0.0);
          vec3 col = vColor * diff;
          float fogFactor = clamp(1.0 - exp(-fogDensity * vDist), 0.0, 1.0);
          col = mix(col, fogColor, fogFactor);
          gl_FragColor = vec4(col, 1.0);
        }`,
        });
        this.mesh = new THREE.InstancedMesh(this.geometry, this.material, count);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0e1c);
        this.scene.add(this.mesh);

        this.camera = new THREE.PerspectiveCamera(48, W / H, 0.1, 200);
        this.camera.position.set(0, 13, 63);
        this.camera.lookAt(0, -9, -5);

        // 오프스크린 캔버스에 렌더 (공용 캔버스는 2D 컨텍스트라 직접 사용 불가)
        this.glCanvas = document.createElement("canvas");
        this.glCanvas.width = W;
        this.glCanvas.height = H;
        this.renderer = new THREE.WebGLRenderer({ canvas: this.glCanvas, antialias: true });
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(W, H, false);
        this.renderer.outputEncoding = THREE.sRGBEncoding;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;

        // UnrealBloomPass는 마지막 패스일 때 bloom만 남기므로, bloom 전용 컴포저로
        // 밝은 부분만 뽑고 base 씬과 합성하는 finalComposer를 별도로 둔다 (원본 패턴)
        const renderPass = new THREE.RenderPass(this.scene, this.camera);
        this.bloomComposer = new THREE.EffectComposer(this.renderer);
        this.bloomComposer.renderToScreen = false;
        this.bloomComposer.addPass(renderPass);
        this.bloomComposer.addPass(new THREE.UnrealBloomPass(
            new THREE.Vector2(W, H), 0.45, 0.4, 0.82));   // 파동 정점 섬광 강화

        const mixPass = new THREE.ShaderPass(
            new THREE.ShaderMaterial({
                uniforms: {
                    baseTexture: { value: null },
                    bloomTexture: { value: this.bloomComposer.renderTarget2.texture },
                },
                vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
                fragmentShader: "uniform sampler2D baseTexture; uniform sampler2D bloomTexture; varying vec2 vUv; void main(){ gl_FragColor = texture2D(baseTexture, vUv) + vec4(1.0) * texture2D(bloomTexture, vUv); }",
            }), "baseTexture");
        mixPass.needsSwap = true;
        mixPass.renderToScreen = true;
        this.composer = new THREE.EffectComposer(this.renderer);
        this.composer.addPass(renderPass);
        this.composer.addPass(mixPass);

        this.clock = new THREE.Clock();
        this.dummy = new THREE.Object3D();

        const 루프 = (now) => {
            this.renderFrame(now);
            this.rafId = requestAnimationFrame(루프);
        };
        this.rafId = requestAnimationFrame(루프);
    }

    /** 새 색상 이벤트 — 원본 handleSound에 해당 (마이크 스트림 연결 지점) */
    onColor(data) {
        const now = performance.now();
        this.rmsHistory.push({ t: now, rms: data.rms });
        while (this.rmsHistory.length && this.rmsHistory[0].t < now - 3000) this.rmsHistory.shift();
        if (!this.renderer) return;   // three.js 미로드 시 무시

        const strength = Math.min(1.4, data.rms * 3);   // 드릴급 큰 소리까지 1.4 상한
        const rgb01 = data.rgb.map(v => v / 255);
        // 파동 색: bands가 있으면 에너지 비중이 가장 큰 대역의 색 —
        // 베이스가 강하면 저음 색 파동, 심벌 구간이면 고음 색 파동 (없으면 대표색 폴백)
        let 파동색 = rgb01;
        if (data.bands) {
            const 우세 = Object.entries(data.bands).sort((a, b) => b[1].ratio - a[1].ratio)[0][1];
            파동색 = 우세.rgb.map(v => v / 255);
        }
        this._현재색 = 파동색;
        // 온셋(타격)은 제자리 스플래시로 즉시 반응 — 색상/파동 스로틀과 분리
        if (data.onset && data.onset.hit) this.onOnset(data.onset.strength, now);

        // 파동: 소리가 나는 동안 450ms 간격으로 1개씩 (임팩트를 위해 원본보다 촘촘하게)
        if (data.rms >= 0.02 && now - this.lastWaveAt > 450) {
            const 원점 = this.중앙근처무작위점();
            this.파동생성(원점.x, 원점.z, 파동색, Math.min(1, strength));
            // 큰 소리의 순간 스플래시
            if (strength > 1.1 && now - this.lastSplashAt > 500) {
                this.스플래시생성(원점.x, 원점.z, 파동색, strength);
                this.lastSplashAt = now;
            }
            this.lastWaveAt = now;
        }
        // 지속음: 필드 전체 틴트 (끝나면 renderFrame의 느린 복귀 보간이 처리)
        if (this.지속음인가(now)) {
            this.tintTarget = 0.32;
            this.tintColor = rgb01;
        } else {
            this.tintTarget = 0;
        }
        this.renderFrame(now);   // rAF가 멈춘 비활성 탭에서도 갱신
    }

    /** 온셋(타격) — 제자리 스플래시가 즉시 솟구침 (짧고 즉각적, 150ms 자체 가드) */
    onOnset(strength, now) {
        if (!this.renderer || now - (this._마지막온셋 || 0) < 150) return;
        this._마지막온셋 = now;
        const 원점 = this.중앙근처무작위점();
        this.스플래시생성(원점.x, 원점.z,
            this._현재색 || [0.85, 0.83, 0.93], 0.5 + strength);
    }

    /** 테마 비활성화 — 루프 정지, three.js/GPU 자원 해제 */
    stop() {
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        this.rafId = null;
        if (this.renderer) {
            this.geometry.dispose();
            this.material.dispose();
            this.renderer.dispose();
            this.renderer.forceContextLoss();   // GL 컨텍스트 즉시 반납 (연타 전환 대비)
        }
        this.renderer = null;
        this.glCanvas = null;
        this.scene = null;
        this.waves = [];
        this.rmsHistory = [];
    }

    /** 결정론적 해시 노이즈 (0~1) */
    해시(x, y) {
        const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
        return s - Math.floor(s);
    }

    /** rms > 0.03 상태가 2초 이상 유지됐는지 (지속음 판정) */
    지속음인가(now) {
        if (this.rmsHistory.length < 6) return false;
        if (this.rmsHistory[0].t > now - 2000) return false;
        return this.rmsHistory.every(e => e.t < now - 2000 || e.rms > 0.03);
    }

    중앙근처무작위점() {
        const half = this.fieldHalf * 0.6;
        return { x: (Math.random() * 2 - 1) * half, z: (Math.random() * 2 - 1) * half };
    }

    /** 파동 발생: 소리 한 번 = 링 하나가 바깥으로 퍼짐 (뒤로 출렁이는 진동 꼬리 동반) */
    파동생성(x, z, colorRgb, strength) {
        this.waves.push({
            x, z, color: colorRgb,
            amplitude: 0.9 * strength, width: 3.2, speed: 15,
            decayRate: 0.45, start: this.clock.elapsedTime,
        });
    }

    /** 큰 소리의 순간 스플래시 (제자리에서 크게 부풀었다 가라앉음, speed=0) */
    스플래시생성(x, z, colorRgb, strength) {
        this.waves.push({
            x, z, color: colorRgb,
            amplitude: 1.3 * strength, width: 2.4, speed: 0,
            decayRate: 1.8, start: this.clock.elapsedTime,
        });
    }

    보간(a, b, t) { return a + (b - a) * t; }
    보간3(a, b, t) {
        return [this.보간(a[0], b[0], t), this.보간(a[1], b[1], t), this.보간(a[2], b[2], t)];
    }
    스무스(a, b, x) {
        const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
    }

    /** 한 프레임: 복셀 갱신 → three.js 렌더 → 메인 캔버스 합성 (원본 _animate) */
    renderFrame(now) {
        if (!this.renderer) return;
        const dt = Math.min(this.clock.getDelta(), 0.05);
        const time = this.clock.elapsedTime;

        // 만료된 파동 제거
        this.waves = this.waves.filter(w => (time - w.start) < 6.5);
        // 지속음 틴트: 상승은 빠르게, 복귀는 8초에 걸쳐 서서히
        const k = this.tintTarget > this.tintAmount ? (1 - Math.exp(-dt * 3)) : (1 - Math.exp(-dt * 0.14));
        this.tintAmount += (this.tintTarget - this.tintAmount) * k;

        const { count, gx, gz, baseHash, variantHash, flickerPhase,
                mesh, dummy, DARK, LIGHT, WHITE, LAVENDER } = this;
        const waves = this.waves;

        for (let i = 0; i < count; i++) {
            const x = gx[i], z = gz[i];
            const hb = baseHash[i];
            const breathing = Math.sin(time * 0.22 + hb * 6.283) * 0.05;   // 필드 전체 숨쉬기
            const flicker = Math.max(0, Math.sin(time * 0.6 + flickerPhase[i]) - 0.986) * 35;
            const baseH = 0.14 + hb * 0.22 + breathing;

            // 모든 활성 파동의 기여 합산
            //  - total(색/글로우): 링 앞머리의 가우시안 (양수)
            //  - heightSum(높이): 넓은 포락선 x cos 진동 — 앞머리 뒤로 산-골-산이
            //    번갈아 따라오며 수면처럼 아래로도 꺼진다 (출렁임의 핵심)
            let total = 0, heightSum = 0, accR = 0, accG = 0, accB = 0;
            for (let w = 0; w < waves.length; w++) {
                const wv = waves[w];
                const dx = x - wv.x, dz = z - wv.z;
                const d = Math.sqrt(dx * dx + dz * dz);
                const t = time - wv.start;
                const ringPos = d - wv.speed * t;
                if (Math.abs(ringPos) > wv.width * 5.5) continue;   // 파동 영향권 밖 — 조기 탈출
                const decay = Math.exp(-t * wv.decayRate);
                if (decay < 0.01) continue;
                const gauss = Math.exp(-(ringPos / wv.width) * (ringPos / wv.width));
                const contrib = wv.amplitude * gauss * decay;
                // 진동 꼬리: 포락선을 2.2배 넓혀 뒤따르는 골·산까지 포함
                const 포락 = Math.exp(-(ringPos / (wv.width * 2.2)) * (ringPos / (wv.width * 2.2)));
                heightSum += wv.amplitude * 포락 * Math.cos(ringPos * 0.75) * decay;
                if (contrib > 0.001) {
                    total += contrib;
                    const graded = this.보간3(wv.color, LAVENDER, 0.45);   // 라벤더 톤 그레이딩
                    accR += graded[0] * contrib;
                    accG += graded[1] * contrib;
                    accB += graded[2] * contrib;
                }
            }
            total += flicker * 0.5;
            const clamped = Math.min(total, 1.3);
            // 높이 출렁임: 위로 최대 +1.6, 아래로 -0.9(골)까지 허용
            const heightClamped = Math.max(-0.9, Math.min(heightSum + flicker * 0.2, 1.6));

            const variant = this.스무스(0.75, 0.95, variantHash[i]);
            let baseColor = this.보간3(DARK, LIGHT, variant);
            if (this.tintAmount > 0.001) baseColor = this.보간3(baseColor, this.tintColor, this.tintAmount);

            let ringColor = LAVENDER;
            if (total > 1e-6) ringColor = [accR / total, accG / total, accB / total];
            let finalColor = this.보간3(baseColor, ringColor, Math.min(clamped, 1));
            const peak = this.스무스(0.7, 1.25, clamped);   // 정점은 흰색으로 번쩍임 → bloom
            finalColor = this.보간3(finalColor, WHITE, peak * 0.7);

            const height = Math.max(0.06, baseH + heightClamped * 3.4);
            const curveY = -(x * x + z * z) * 0.00075;      // 필드가 지평선처럼 살짝 휘어짐
            dummy.position.set(x, curveY + height / 2, z);
            dummy.scale.set(1, height, 1);
            dummy.rotation.set(0, 0, 0);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
            const ci = i * 3;
            this.instColorAttr.array[ci] = finalColor[0];
            this.instColorAttr.array[ci + 1] = finalColor[1];
            this.instColorAttr.array[ci + 2] = finalColor[2];
        }
        mesh.instanceMatrix.needsUpdate = true;
        this.instColorAttr.needsUpdate = true;

        this.bloomComposer.render();
        this.composer.render();

        // ── 메인 캔버스 합성 + 비네트/라벨 ─────────────────────────
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(this.glCanvas, 0, 0, W, H);
        // 가장자리 비네트 (원본의 inset box-shadow 대응)
        const 비네트 = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 0.85);
        비네트.addColorStop(0, "rgba(0,0,0,0)");
        비네트.addColorStop(1, "rgba(0,0,0,0.55)");
        ctx.fillStyle = 비네트;
        ctx.fillRect(0, 0, W, H);
        // 타이틀 + 상태 라벨
        if (waves.length) {
            const lead = waves[waves.length - 1].color;
            this.lastHex = "#" + lead.map(c =>
                Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("");
        }
        ctx.font = "11px ui-monospace, Menlo, monospace";
        ctx.fillStyle = "rgba(216,212,236,0.5)";
        ctx.fillText("Sound to Color — Voxel Wave Field", 12, 18);
        ctx.fillStyle = "rgba(216,212,236,0.55)";
        ctx.fillText(`${this.lastHex} · waves: ${waves.length}`, 12, H - 12);
    }
}
