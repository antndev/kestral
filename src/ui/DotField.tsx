import { memo, useEffect, useRef } from "react";

type Dot = { ax: number; ay: number; sx: number; sy: number };

export const DotField = memo(function DotField({
  dotRadius = 1.6,
  dotSpacing = 18,
  cursorRadius = 500,
  bulgeStrength = 55,
  from,
  to,
}: {
  dotRadius?: number;
  dotSpacing?: number;
  cursorRadius?: number;
  bulgeStrength?: number;
  from: string;
  to: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const mouse = { x: -9999, y: -9999, px: -9999, py: -9999, speed: 0 };
    let size = { w: 0, h: 0, left: 0, top: 0 };
    let dots: Dot[] = [];
    let engagement = 0;
    let raf = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    const build = () => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      const { width: w, height: h } = rect;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      size = { w, h, left: rect.left, top: rect.top };
      const step = dotRadius + dotSpacing;
      const cols = Math.floor(w / step);
      const rows = Math.floor(h / step);
      const padX = (w % step) / 2;
      const padY = (h % step) / 2;
      dots = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const ax = padX + c * step + step / 2;
          const ay = padY + r * step + step / 2;
          dots.push({ ax, ay, sx: ax, sy: ay });
        }
      }
    };

    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(build, 100);
    };
    const onMove = (e: MouseEvent) => {
      mouse.x = e.clientX - size.left;
      mouse.y = e.clientY - size.top;
    };
    const speedTimer = setInterval(() => {
      const dist = Math.hypot(mouse.px - mouse.x, mouse.py - mouse.y);
      mouse.speed += (dist - mouse.speed) * 0.5;
      if (mouse.speed < 0.001) mouse.speed = 0;
      mouse.px = mouse.x;
      mouse.py = mouse.y;
    }, 20);

    const tick = () => {
      const { w, h } = size;
      engagement += (Math.min(mouse.speed / 5, 1) - engagement) * 0.06;
      if (engagement < 0.001) engagement = 0;
      ctx.clearRect(0, 0, w, h);
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, from);
      grad.addColorStop(1, to);
      ctx.fillStyle = grad;
      const crSq = cursorRadius * cursorRadius;
      const rad = dotRadius / 2;
      ctx.beginPath();
      for (const d of dots) {
        const dx = mouse.x - d.ax;
        const dy = mouse.y - d.ay;
        const distSq = dx * dx + dy * dy;
        if (distSq < crSq && engagement > 0.01) {
          const t = 1 - Math.sqrt(distSq) / cursorRadius;
          const push = t * t * bulgeStrength * engagement;
          const angle = Math.atan2(dy, dx);
          d.sx += (d.ax - Math.cos(angle) * push - d.sx) * 0.15;
          d.sy += (d.ay - Math.sin(angle) * push - d.sy) * 0.15;
        } else {
          d.sx += (d.ax - d.sx) * 0.1;
          d.sy += (d.ay - d.sy) * 0.1;
        }
        ctx.moveTo(d.sx + rad, d.sy);
        ctx.arc(d.sx, d.sy, rad, 0, Math.PI * 2);
      }
      ctx.fill();
      raf = requestAnimationFrame(tick);
    };

    build();
    window.addEventListener("resize", onResize);
    window.addEventListener("mousemove", onMove, { passive: true });
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(speedTimer);
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("mousemove", onMove);
    };
  }, [dotRadius, dotSpacing, cursorRadius, bulgeStrength, from, to]);

  return <canvas ref={canvasRef} aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />;
});
