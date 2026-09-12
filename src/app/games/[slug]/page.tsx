import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GameShell } from "@/components/games/GameShell";
import { GAMES, getGame } from "@/lib/games/registry";

export function generateStaticParams() {
  return GAMES.map((game) => ({ slug: game.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const game = getGame(slug);
  if (!game) return { title: "3D 游戏 | MonsterAI Lab" };
  return {
    title: `${game.title} | MonsterAI Lab`,
    description: game.blurb,
  };
}

export default async function GamePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const game = getGame(slug);
  if (!game) notFound();
  return <GameShell slug={game.id} />;
}
