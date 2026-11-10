"use client";

import { track } from "@vercel/analytics";
import { useEffect, useRef, useState, type ReactNode } from "react";

export type Demo = {
  label: string;
  media: { kind: "video"; src: string; poster: string; size: [number, number] } | { kind: "image"; src: string; alt: string; size: [number, number] };
  caption: ReactNode;
};

export default function Carousel({ demos }: { demos: Demo[] }) {
  const [current, setCurrent] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const videos = useRef<(HTMLVideoElement | null)[]>([]);

  function show(index: number) {
    setCurrent((index + demos.length) % demos.length);
    setCycle((n) => n + 1);
    setPaused(false);
  }

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.intersectionRatio >= 0.99), { threshold: 1 });
    if (frame.current) observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (scrolled) return;
    const onScroll = () => setScrolled(true);
    window.addEventListener("scroll", onScroll, { once: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [scrolled]);

  useEffect(() => {
    const video = videos.current[current];
    if (video) video.currentTime = 0;
  }, [current, cycle]);

  useEffect(() => {
    videos.current.forEach((video, i) => {
      if (!video) return;
      if (scrolled && visible && i === current && !paused) video.play().catch(() => {});
      else video.pause();
    });
  }, [current, cycle, visible, scrolled, paused]);

  return (
    <div className="carousel">
      <div className="tabs">
        {demos.map((demo, i) => (
          <button
            key={demo.label}
            className={i === current ? "on" : undefined}
            onClick={() => {
              show(i);
              track("demo_selected", { demo: demo.label });
            }}
          >
            {demo.label}
          </button>
        ))}
      </div>
      <div className="stage">
        <div ref={frame} className="slides" style={{ aspectRatio: `${demos[current].media.size[0]} / ${demos[current].media.size[1]}` }}>
          {demos.map((demo, i) => (
            <div key={demo.label} className={i === current ? "slide on" : "slide"}>
              {demo.media.kind === "video" ? (
                <video
                  ref={(el) => {
                    videos.current[i] = el;
                  }}
                  src={demo.media.src}
                  poster={demo.media.poster}
                  muted
                  onEnded={() => i === current && show(current + 1)}
                  onClick={() => {
                    track(paused ? "demo_resumed" : "demo_paused", { demo: demo.label });
                    setPaused(!paused);
                  }}
                  playsInline
                  preload="metadata"
                />
              ) : (
                <img src={demo.media.src} alt={demo.media.alt} />
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="captions">
        {demos.map((demo, i) => (
          <p key={demo.label} className={i === current ? "on" : undefined}>
            {demo.caption}
          </p>
        ))}
      </div>
    </div>
  );
}
