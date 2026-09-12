import type { Metadata } from "next";
import { GamesHub } from "@/components/games/GamesHub";

export const metadata: Metadata = {
  title: "3D 游戏实验室 | MonsterAI Lab",
  description: "二十六种 Three.js 浏览器 3D 游戏：射击、竞速、塔防、解谜、空战、台球、推箱子等。",
};

export default function GamesPage() {
  return <GamesHub />;
}
