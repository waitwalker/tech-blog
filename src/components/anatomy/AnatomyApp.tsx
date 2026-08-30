"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import {
  ArrowRight,
  BookOpen,
  Bookmark,
  BrainCircuit,
  ChevronDown,
  CircleHelp,
  Compass,
  FileText,
  Globe,
  Heart,
  LibraryBig,
  Microscope,
  NotebookPen,
  Play,
  Search,
  Share2,
  Sparkles,
  Stethoscope,
  X,
} from "lucide-react";
import { OrganViewer } from "./OrganViewer";
import type { OrganId } from "@/lib/anatomy/anatomy-data";
import type { LocaleConfig } from "@/lib/anatomy/i18n/config";
import { locales, defaultLocale } from "@/lib/anatomy/i18n/config";
import { buildOrgans, indexOrgans, type Organ } from "@/lib/anatomy/i18n/merge";
import { format, type Dictionary, type UiDictionary } from "@/lib/anatomy/i18n/types";
import { getDictionary } from "@/lib/anatomy/i18n/dictionaries";
import "./anatomy.css";

type Modal = "lesson" | "quiz" | "animation" | "system" | null;

/**
 * Renders an organ illustration, or its accent glyph for organs that ship as a
 * 3D model without the painted asset set.
 */
function OrganArt({
  organ,
  asset,
  alt,
  size,
}: {
  organ: Organ;
  asset: "thumb" | "organ" | "microscopic" | "compare" | "location";
  alt: string;
  size?: number;
}) {
  if (!organ.illustrated) {
    const labelling = alt ? { role: "img", "aria-label": alt } : { "aria-hidden": true };
    return (
      <span className="art-fallback" style={{ "--art-accent": organ.accent } as React.CSSProperties} {...labelling}>
        {organ.icon}
      </span>
    );
  }
  return (
    <img
      key={`${organ.id}-${asset}`}
      src={`/anatomy/${organ.id}/${asset}.webp`}
      alt={alt}
      width={size}
      height={size}
      loading={asset === "thumb" ? "eager" : "lazy"}
      decoding="async"
    />
  );
}

function Measure({ children }: { children: string }) {
  return <bdi dir={/^[\d(]/.test(children.trim()) ? "ltr" : "auto"}>{children}</bdi>;
}

function LanguageSwitcher({
  locale,
  t,
  onSelectLocale,
}: {
  locale: LocaleConfig;
  t: UiDictionary;
  onSelectLocale: (code: string) => void;
}) {
  return (
    <div className="language-switcher" title={t.language.label}>
      <Globe size={16} aria-hidden />
      <span className="language-current">{locale.nativeName}</span>
      <ChevronDown size={14} aria-hidden />
      <select
        aria-label={t.language.choose}
        value={locale.code}
        onChange={(event) => {
          onSelectLocale(event.target.value);
        }}
      >
        {locales.map((entry) => (
          <option key={entry.code} value={entry.code} lang={entry.code}>
            {entry.nativeName}
          </option>
        ))}
      </select>
    </div>
  );
}

export function AnatomyApp({
  initialLocale = "zh",
  initialDictionary,
}: {
  initialLocale?: string;
  initialDictionary?: Dictionary;
}) {
  const [currentLocaleCode, setCurrentLocaleCode] = useState(initialLocale);
  const [dictionary, setDictionary] = useState<Dictionary | null>(initialDictionary || null);

  useEffect(() => {
    let active = true;
    getDictionary(currentLocaleCode).then((dict) => {
      if (active) setDictionary(dict);
    });
    return () => {
      active = false;
    };
  }, [currentLocaleCode]);

  const locale = useMemo(
    () => locales.find((l) => l.code === currentLocaleCode) || locales.find((l) => l.code === defaultLocale)!,
    [currentLocaleCode],
  );

  const t = dictionary?.ui;
  const organs = useMemo(() => (dictionary ? buildOrgans(dictionary.organs) : []), [dictionary]);
  const organById = useMemo(() => (organs.length > 0 ? indexOrgans(organs) : ({} as Record<OrganId, Organ>)), [organs]);

  const [organId, setOrganId] = useState<OrganId>("heart");
  const [autoRotate, setAutoRotate] = useState(true);
  const [compare, setCompare] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [query, setQuery] = useState("");
  const [mobileLibrary, setMobileLibrary] = useState(false);
  const [quizActive, setQuizActive] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const prefetched = useRef(new Set<OrganId>());

  const organ = organById[organId] || organs[0];
  const reference = organById[organId === "heart" ? "brain" : "heart"] || organs[1];

  const filteredOrgans = useMemo(
    () =>
      organs.filter((item) =>
        `${item.name} ${item.system}`.toLocaleLowerCase(locale.code).includes(query.toLocaleLowerCase(locale.code)),
      ),
    [organs, query, locale.code],
  );

  useEffect(() => {
    if (!contentRef.current) return;
    gsap.fromTo(
      contentRef.current.querySelectorAll("[data-reveal]"),
      { opacity: 0, y: 8 },
      { opacity: 1, y: 0, duration: 0.48, stagger: 0.035, ease: "power2.out", overwrite: true },
    );
  }, [organId, currentLocaleCode]);

  if (!t || !organ) {
    return (
      <div className="flex items-center justify-center min-h-[600px] text-zinc-400">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm font-mono tracking-wider">LOADING 3D ATELIER...</span>
        </div>
      </div>
    );
  }

  const selectOrgan = (id: OrganId) => {
    if (organById[id]?.illustrated) {
      ["organ", "microscopic", "compare", "location"].forEach((asset) => {
        const image = new Image();
        image.src = `/anatomy/${id}/${asset}.webp`;
      });
    }
    setOrganId(id);
    setMobileLibrary(false);
    setCompare(false);
    setQuizActive(false);
  };

  const prefetchOrgan = (id: OrganId) => {
    if (id === organId || prefetched.current.has(id) || !organById[id]) return;
    prefetched.current.add(id);
    void fetch(organById[id].model, { priority: "low" } as RequestInit).catch(() => {});
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => selectOrgan("heart")} aria-label={t.brand.home}>
          <strong>Anatomy Atelier<sup>✦</sup></strong>
          <em>{t.brand.tagline}</em>
        </button>
        <nav className="main-nav" aria-label="Primary navigation">
          <button className="active"><Compass size={17} /> {t.nav.explore}</button>
          <button onClick={() => setModal("system")}><BrainCircuit size={17} /> {t.nav.systems}</button>
          <button onClick={() => setModal("lesson")}><BookOpen size={17} /> {t.nav.lessons}</button>
          <button onClick={() => setMobileLibrary(true)}><LibraryBig size={17} /> {t.nav.library}</button>
          <button><NotebookPen size={17} /> {t.nav.notes}</button>
        </nav>
        <label className="search-box">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.search.placeholder} />
        </label>
        <LanguageSwitcher locale={locale} t={t} onSelectLocale={(code) => setCurrentLocaleCode(code)} />
        <button className="profile" aria-label={t.profile.open}><span>MA</span><ChevronDown size={15} /></button>
        <button className="mobile-library-trigger" onClick={() => setMobileLibrary(true)} aria-label={t.library.open}><LibraryBig size={20} /></button>
      </header>

      <div className="workspace">
        <aside className={`organ-library ${mobileLibrary ? "open" : ""}`}>
          <div className="panel-heading">
            <span>{t.library.title}</span>
            <button aria-label={t.library.close} className="mobile-close" onClick={() => setMobileLibrary(false)}><X size={17} /></button>
            <button aria-label={t.library.saved}><Bookmark size={17} /></button>
          </div>
          <div className="organ-list">
            {filteredOrgans.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`organ-item ${organId === item.id ? "active" : ""}`}
                onClick={() => selectOrgan(item.id)}
                onPointerEnter={() => prefetchOrgan(item.id)}
                onFocus={() => prefetchOrgan(item.id)}
                style={{ "--item-accent": item.accent } as React.CSSProperties}
              >
                <span className="organ-glyph">
                  <OrganArt organ={item} asset="thumb" alt="" size={47} />
                </span>
                <span><b>{item.name}</b><small>{item.system}</small></span>
                {organId === item.id && <Heart className="favorite" size={14} fill="currentColor" />}
              </button>
            ))}
          </div>
          <button className="view-all" onClick={() => setQuery("")}>{t.library.viewAll} <ArrowRight size={14} /></button>
          <blockquote>
            <Sparkles size={18} />
            <p>{t.library.quoteLine1}<br />{t.library.quoteLine2}</p>
            <em>{t.library.quoteSign}</em>
          </blockquote>
        </aside>

        <OrganViewer
          organ={organ}
          t={t}
          autoRotate={autoRotate}
          onAutoRotate={setAutoRotate}
          compare={compare}
          onCompare={() => setCompare(!compare)}
          quizActive={quizActive}
          onQuizExit={() => setQuizActive(false)}
        />

        <aside className="info-panel" ref={contentRef}>
          <div className="info-kicker" data-reveal><Heart size={13} fill="currentColor" /> {format(t.info.kicker, { organ: organ.name })}</div>
          <div className="info-title-row" data-reveal>
            <div><h1>{organ.name}</h1><em>{organ.poetic}</em></div>
            <span className="specimen-stamp">
              <OrganArt organ={organ} asset="organ" alt="" size={92} />
            </span>
          </div>
          <p className="description" data-reveal>{organ.description}</p>
          <div className="rule" />
          <h2 data-reveal>{t.info.keyFacts}</h2>
          <dl className="key-facts">
            <div data-reveal><dt><span>◇</span> {t.info.size}</dt><dd><Measure>{organ.size}</Measure></dd></div>
            <div data-reveal><dt><span>♙</span> {t.info.weight}</dt><dd><Measure>{organ.weight}</Measure></dd></div>
            <div data-reveal><dt><span>⌁</span> {t.info.daily}</dt><dd><Measure>{organ.dailyFact}</Measure></dd></div>
            <div data-reveal><dt><span>⌖</span> {t.info.location}</dt><dd><Measure>{organ.location}</Measure></dd></div>
            <div data-reveal><dt><span>❋</span> {t.info.bloodSupply}</dt><dd><Measure>{organ.bloodSupply}</Measure></dd></div>
            <div data-reveal><dt><span>◈</span> {t.info.function}</dt><dd><Measure>{organ.function}</Measure></dd></div>
          </dl>
          <div className="medical-note" data-reveal><Stethoscope size={16} /><p><b>{t.info.medical}</b>{organ.medical}</p></div>
          <div className="fun-note" data-reveal><Sparkles size={15} /><p><b>{t.info.didYouKnow}</b>{organ.funFact}</p></div>
          <button className="lesson-button" data-reveal onClick={() => setModal("lesson")}>{t.info.viewLesson} <ArrowRight size={16} /></button>
          <div className="action-grid" data-reveal>
            <button onClick={() => setModal("animation")}><Play size={15} /> {t.info.animate}</button>
            <button onClick={() => { setQuizActive(true); setModal(null); }}><CircleHelp size={15} /> {t.info.quiz}</button>
            <button onClick={() => setCompare(!compare)} className={compare ? "active" : ""}><Share2 size={15} /> {t.info.compare}</button>
          </div>
        </aside>
      </div>

      {compare && (
        <section className="compare-strip" aria-label={t.compare.title}>
          <div className="compare-organ"><OrganArt organ={organ} asset="thumb" alt="" /><span>{t.compare.comparing}</span><strong>{organ.name}</strong><small>{organ.system}</small></div>
          <b>{t.compare.vs}</b>
          <div className="compare-organ"><OrganArt organ={reference} asset="thumb" alt="" /><span>{t.compare.reference}</span><strong>{reference.name}</strong><small>{reference.system}</small></div>
          <dl><div><dt>{t.compare.primaryRole}</dt><dd><Measure>{organ.function}</Measure></dd></div><div><dt>{t.compare.scale}</dt><dd><Measure>{organ.size}</Measure></dd></div></dl>
          <button onClick={() => setCompare(false)} aria-label={t.compare.close}><X size={16} /></button>
        </section>
      )}

      <section className="learning-cards" aria-label={format(t.cards.resources, { organ: organ.name })}>
        <article className="curiosity-card">
          <span>✿</span><p>{t.library.quoteLine1}<br />{t.library.quoteLine2}</p><em>{t.library.quoteSign}</em>
        </article>
        <article>
          <header><div><em>{t.cards.microscopic}</em><h3>{organ.tissue}</h3></div><Microscope size={17} /></header>
          <div className="microscope-visual organ-card-image"><OrganArt organ={organ} asset="microscopic" alt="" /></div>
          <button onClick={() => setModal("lesson")}>{t.cards.exploreTissue} <ArrowRight size={14} /></button>
        </article>
        <article>
          <header><div><em>{t.cards.compareOrgans}</em><h3>{organ.comparison}</h3></div><Share2 size={17} /></header>
          <div className="comparison-visual organ-card-image"><OrganArt organ={organ} asset="compare" alt="" /></div>
          <button onClick={() => setCompare(true)}>{t.cards.openComparison} <ArrowRight size={14} /></button>
        </article>
        <article>
          <header><div><em>{t.cards.functionAnimation}</em><h3>{organ.function}</h3></div><Play size={17} /></header>
          <button
            type="button"
            className="function-visual organ-card-image"
            onClick={() => setModal("animation")}
            aria-label={format(t.cards.playAria, { organ: organ.name })}
          >
            <OrganArt organ={organ} asset="organ" alt="" />
            <i className="function-pulse" />
            <span className="play-badge"><Play size={18} fill="currentColor" /></span>
          </button>
          <button onClick={() => setModal("animation")}>{t.cards.playAnimation} <ArrowRight size={14} /></button>
        </article>
        <article>
          <header><div><em>{t.cards.clinicalNotes}</em><h3>{t.cards.commonConditions}</h3></div><FileText size={17} /></header>
          <ul>{organ.conditions.map((condition) => <li key={condition}>{condition}</li>)}</ul>
          <button onClick={() => setModal("lesson")}>{t.cards.seeAll} <ArrowRight size={14} /></button>
        </article>
        <article className="system-card">
          <header><div><em>{t.cards.whereItWorks}</em><h3>{organ.system}</h3></div><BrainCircuit size={17} /></header>
          <button
            type="button"
            className="system-visual organ-card-image"
            onClick={() => setModal("system")}
            aria-label={format(t.cards.systemAria, { organ: organ.name })}
          >
            <OrganArt organ={organ} asset="location" alt="" />
          </button>
          <button onClick={() => setModal("system")}>{t.cards.seeSystem} <ArrowRight size={14} /></button>
        </article>
      </section>

      {modal && <LearningModal type={modal} organ={organ} t={t} onClose={() => setModal(null)} />}
      {mobileLibrary && <button className="drawer-backdrop" aria-label={t.library.close} onClick={() => setMobileLibrary(false)} />}
    </main>
  );
}

const MODAL_ICON: Record<Exclude<Modal, null>, string> = {
  quiz: "?",
  animation: "▶",
  system: "⌖",
  lesson: "✦",
};

function LearningModal({
  type,
  organ,
  t,
  onClose,
}: {
  type: Exclude<Modal, null>;
  organ: Organ;
  t: UiDictionary;
  onClose: () => void;
}) {
  const vars = { organ: organ.name, location: organ.location };
  const title =
    type === "quiz" ? format(t.modal.quizTitle, vars)
    : type === "animation" ? format(t.modal.motionTitle, vars)
    : type === "system" ? format(t.modal.bodyTitle, vars)
    : format(t.modal.insideTitle, vars);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`learning-modal ${type === "system" ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label={t.modal.close}><X size={18} /></button>
        <span className="modal-icon">{MODAL_ICON[type]}</span>
        <em>{t.modal.guided}</em>
        <h2 id="modal-title">{title}</h2>
        {type === "quiz" ? (
          <div className="quiz-options">
            <p>{format(t.modal.quizPrompt, vars)}</p>
            <button onClick={onClose}>{t.modal.quizA}</button>
            <button onClick={onClose}>{t.modal.quizB}</button>
            <button onClick={onClose}>{t.modal.quizC}</button>
          </div>
        ) : type === "system" ? (
          <>
            <p>{format(t.modal.systemIntro, vars)}</p>
            <figure className="modal-figure">
              <OrganArt organ={organ} asset="location" alt="" />
            </figure>
            <dl className="modal-facts">
              <div><dt>{t.modal.system}</dt><dd>{organ.system}</dd></div>
              <div><dt>{t.modal.primaryRole}</dt><dd><Measure>{organ.function}</Measure></dd></div>
              <div><dt>{t.modal.bloodSupply}</dt><dd><Measure>{organ.bloodSupply}</Measure></dd></div>
            </dl>
            <button className="lesson-button" onClick={onClose}>{t.modal.continueExploring} <ArrowRight size={16} /></button>
          </>
        ) : (
          <>
            <p>{t.modal.lessonBody}</p>
            <div className={`modal-demo ${type === "animation" ? "moving" : ""}`}><OrganArt organ={organ} asset="organ" alt="" /></div>
            <button className="lesson-button" onClick={onClose}>{t.modal.continueExploring} <ArrowRight size={16} /></button>
          </>
        )}
      </section>
    </div>
  );
}
