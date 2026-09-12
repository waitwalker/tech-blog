import { flutterArticles } from "./flutter";
import { flutterMoreA } from "./flutter-more-a";
import { flutterMoreB } from "./flutter-more-b";
import { nestjsArticles } from "./nestjs";
import { nestjsA } from "./nestjs-a";
import { nestjsB } from "./nestjs-b";
import { nextjsArticles } from "./nextjs";
import { nextjsA } from "./nextjs-a";
import { nextjsB } from "./nextjs-b";
import { nextjsDeep1 } from "./nextjs-deep-1";
import { nextjsDeep2 } from "./nextjs-deep-2";
import { nextjsDeep3 } from "./nextjs-deep-3";
import { rustArticles } from "./rust";

export const articleBodies: Record<string, string> = {
  ...flutterArticles,
  ...flutterMoreA,
  ...flutterMoreB,
  ...nestjsArticles,
  ...nestjsA,
  ...nestjsB,
  ...nextjsArticles,
  ...nextjsA,
  ...nextjsB,
  ...nextjsDeep1,
  ...nextjsDeep2,
  ...nextjsDeep3,
  ...rustArticles,
};
