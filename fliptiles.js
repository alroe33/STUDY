// ============================================================================
// 플립 타일(Flip Tiles) 테마 — 25x25 타일이 중앙에서 가장자리로 물결치듯
// 뒤집히며 새 색으로 전환되는 컨셉
// ThemeBase 규약: constructor(canvas) / start() / onColor(data) / stop()
// ============================================================================
class FlipTilesTheme {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.N = 25;            // 25x25 = 625장
        this.GAP = 3;           // 타일 간격 3px
        this.FLIP_MS = 420;     // 타일당 플립 시간
        this.tiles = [];        // 타일 상태 배열
        this.rafId = null;      // requestAnimationFrame 핸들
        this.lastHsl = null;    // 마지막으로 물결을 일으킨 색 (변화 감지용)
    }

    /** 테마 활성화 시 1회 호출 — 타일 초기화, 애니메이션 루프 시작 */
    start() {
        const W = this.canvas.width, H = this.canvas.height;
        this.ctx.clearRect(0, 0, W, H);
        this.lastHsl = null;
        const 폭 = (W - this.GAP * (this.N + 1)) / this.N;
        const 높이 = (H - this.GAP * (this.N + 1)) / this.N;
        this.tiles = [];
        for (let gy = 0; gy < this.N; gy++) {
            for (let gx = 0; gx < this.N; gx++) {
                // 초기 타일 색: 어두운 회청색 + 타일마다 밝기 ±14 랜덤 편차 (단조로움 방지)
                const 편차 = Math.round((Math.random() * 2 - 1) * 14);
                this.tiles.push({
                    gx, gy,
                    x: this.GAP + gx * (폭 + this.GAP),
                    y: this.GAP + gy * (높이 + this.GAP),
                    w: 폭, h: 높이,
                    편차,                                     // 이후 들어오는 색에도 같은 편차 적용
                    color: this.편차적용([46, 54, 68], 편차),  // 현재 면 색
                    next: null,                               // 뒤집힌 뒤 보여줄 색
                    flipStart: Infinity,                      // 뒤집힘 시작 예약 시각
                    spark: 0,                                 // 온셋 스파클 시각
                });
            }
        }
        const 루프 = (now) => {
            this.renderFrame(now);
            this.rafId = requestAnimationFrame(루프);
        };
        this.rafId = requestAnimationFrame(루프);
    }

    /** 새 색상 이벤트 — 색이 충분히 변했을 때만 물결 트리거.
        (백엔드가 10fps로 보내므로 매번 재예약하면 타일이 영영 못 뒤집힌다) */
    onColor(data) {
        const now = performance.now();
        // 온셋 스파클은 색상 로직과 분리해 즉시 처리
        if (data.onset && data.onset.hit) this.onOnset(data.onset.strength, now);

        const [h, s, l] = data.hsl;
        let 트리거 = false;
        if (this.lastHsl === null) {
            트리거 = true;   // 첫 색은 무조건 물결
        } else {
            const 색조차이 = Math.min(Math.abs(h - this.lastHsl[0]),
                                    360 - Math.abs(h - this.lastHsl[0]));
            if (색조차이 > 30 || Math.abs(l - this.lastHsl[2]) > 0.15) 트리거 = true;
        }
        if (트리거) {
            // bands가 있으면 반지름 구간별 3색 물결, 없으면 단일 색(하위 호환)
            this.물결트리거(data.rgb, now, data.bands || null);
            this.lastHsl = [h, s, l];
        }
        this.renderFrame(now);   // rAF가 멈춘 비활성 탭에서도 수신 시점에 갱신
    }

    /** 온셋(타격) 스파클 — 무작위 타일 3~15장이 즉시 반짝 (120ms 후 원복) */
    onOnset(strength, now) {
        const 장수 = 3 + Math.round(strength * 12);
        for (let i = 0; i < 장수; i++) {
            const 타일 = this.tiles[Math.floor(Math.random() * this.tiles.length)];
            if (타일) 타일.spark = now;
        }
    }

    /** 테마 비활성화 — 애니메이션 루프 정지, 내부 상태 리셋 */
    stop() {
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        this.rafId = null;
        this.tiles = [];
        this.lastHsl = null;
    }

    /** 중앙에서 가장자리로 퍼지는 원형 물결로 전체 타일의 뒤집힘을 예약한다.
        bands가 있으면 반지름 구간별로 다른 밴드 색: 중심부 mid → 중간 링 low →
        바깥 링 high — 물결이 3색 그러데이션을 그리며 퍼진다. */
    물결트리거(rgb, now, bands = null) {
        const 중앙 = (this.N - 1) / 2;
        for (const 타일 of this.tiles) {
            // 전환 도중 새 색이 또 들어오면: 이미 절반 넘게 뒤집힌 타일은 next를 커밋하고,
            // next 색과 예약 시각만 갱신 (자연스러운 연속 전환)
            const p = (now - 타일.flipStart) / this.FLIP_MS;
            if (타일.next !== null && p >= 0.5) 타일.color = 타일.next;
            // 뒤집힘 시작 시각 = 중앙으로부터의 유클리드 거리 x 55ms + 랜덤 지터 0~40ms
            const 거리 = Math.hypot(타일.gx - 중앙, 타일.gy - 중앙);
            타일.flipStart = now + 거리 * 55 + Math.random() * 40;
            let 색 = rgb;
            if (bands) {
                색 = 거리 < 4.5 ? bands.mid.rgb : (거리 < 9 ? bands.low.rgb : bands.high.rgb);
            }
            타일.next = this.편차적용(색, 타일.편차);
        }
    }

    /** 색에 타일 고유의 밝기 편차를 적용한다 */
    편차적용(rgb, 편차) {
        return rgb.map(c => Math.max(0, Math.min(255, Math.round(c + 편차))));
    }

    /** 색에 밝기 배율을 적용한 CSS 색 문자열을 만든다 */
    색문자열(rgb, 배율) {
        const [r, g, b] = rgb.map(c => Math.max(0, Math.min(255, Math.round(c * 배율))));
        return `rgb(${r},${g},${b})`;
    }

    /** 한 프레임 렌더링 (배경 → 각 타일의 플립 상태) */
    renderFrame(now) {
        const ctx = this.ctx;
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "#0d0f14";                       // 배경
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        for (const 타일 of this.tiles) {
            const p = (now - 타일.flipStart) / this.FLIP_MS;   // 플립 진행도
            // 온셋 스파클: 120ms 동안 밝기 1.4배 (물결과 무관한 즉각 반짝임)
            const 스파크 = (now - 타일.spark < 120) ? 1.4 : 1;

            if (타일.flipStart === Infinity || p < 0) {
                // 아직 예약 전/대기 중 — 현재 색 그대로
                this.타일그리기(타일, 타일.color, 스파크, true);
            } else if (p >= 1) {
                // 플립 완료 — 새 색을 현재 색으로 커밋
                if (타일.next !== null) { 타일.color = 타일.next; 타일.next = null; }
                타일.flipStart = Infinity;
                this.타일그리기(타일, 타일.color, 스파크, true);
            } else {
                // 플립 중: scaleY = |cos(p*PI)| 로 높이 압축 (세로축 회전 시뮬레이션)
                const scaleY = Math.abs(Math.cos(p * Math.PI));
                const 면색 = p < 0.5 ? 타일.color : (타일.next || 타일.color);
                // 밝기: 뒤집히는 중간에 어두워짐 (입체감)
                let 밝기 = (0.45 + 0.55 * scaleY) * 스파크;
                // 새 면이 드러나는 순간의 섬광 하이라이트
                if (p >= 0.5 && p <= 0.62) 밝기 *= 1.25;

                if (scaleY < 0.07) {
                    // 거의 0인 순간: 얇은 어두운 가로선만 표시 (타일 옆면)
                    const cy = 타일.y + 타일.h / 2;
                    ctx.fillStyle = "rgb(18,20,26)";
                    ctx.fillRect(타일.x, cy - 0.6, 타일.w, 1.2);
                } else {
                    const h2 = 타일.h * scaleY;
                    const y2 = 타일.y + (타일.h - h2) / 2;
                    ctx.fillStyle = this.색문자열(면색, 밝기);
                    ctx.fillRect(타일.x, y2, 타일.w, h2);
                    // 광택 오버레이: 상단 28%, 충분히 펴졌을 때만
                    if (scaleY > 0.85) {
                        ctx.fillStyle = "rgba(255,255,255,0.06)";
                        ctx.fillRect(타일.x, y2, 타일.w, h2 * 0.28);
                    }
                }
            }
        }
    }

    /** 정지 상태의 타일 하나를 그린다 */
    타일그리기(타일, rgb, 밝기, 광택) {
        const ctx = this.ctx;
        ctx.fillStyle = this.색문자열(rgb, 밝기);
        ctx.fillRect(타일.x, 타일.y, 타일.w, 타일.h);
        if (광택) {
            ctx.fillStyle = "rgba(255,255,255,0.06)";   // 상단 28% 광택
            ctx.fillRect(타일.x, 타일.y, 타일.w, 타일.h * 0.28);
        }
    }
}
