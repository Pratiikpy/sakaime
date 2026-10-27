import React from "react";
import { FootageScene } from "../components/Footage";
import { FOOTAGE } from "../footageConfigs";
import { Close } from "./Close";
import { Hook } from "./Hook";
import { Limits } from "./Limits";
import { Pipeline } from "./Pipeline";
import { Problem } from "./Problem";
import { Results } from "./Results";
import { Sponsors } from "./Sponsors";
import { Terminal } from "./Terminal";
import { UslPlus } from "./Usl";

type SceneComponent = React.ComponentType<{ index: number }>;

function footage(id: string): SceneComponent {
  const config = FOOTAGE[id];
  if (!config) throw new Error(`no footage config for ${id}`);
  const Scene: SceneComponent = () => <FootageScene config={config} />;
  return Scene;
}

export const SCENE_COMPONENTS: Record<string, SceneComponent> = {
  hook: () => <Hook />,
  problem: () => <Problem />,
  pipeline: () => <Pipeline />,
  addsource: footage("addsource"),
  console: footage("console"),
  matrix: footage("matrix"),
  usl: footage("usl"),
  uslplus: () => <UslPlus />,
  identity: footage("identity"),
  xray: footage("xray"),
  lab: footage("lab"),
  timeline: footage("timeline"),
  desk: footage("desk"),
  investigation: footage("investigation"),
  guard: footage("guard"),
  drills: footage("drills"),
  dossier: footage("dossier"),
  judge: () => <Terminal />,
  sponsors: () => <Sponsors />,
  results: () => <Results />,
  limits: () => <Limits />,
  close: () => <Close />,
};
