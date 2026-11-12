// Shared Chrome launcher for the scripts.
// Uses the machine's real GPU: SwiftShader (software WebGL) is ~90× slower on this scene
// (a 1 s export took 64 s vs 0.7 s on an M2). Set SWIFTSHADER=1 on machines without a GPU (CI).
import { chromium } from 'playwright';

export function launch(args = []) {
  const gpu = process.env.SWIFTSHADER ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--ignore-gpu-blocklist'];
  return chromium.launch({ channel: 'chrome', args: [...gpu, ...args] });
}
