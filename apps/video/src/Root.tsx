import { Composition } from 'remotion';
import { Launch, type LaunchProps } from './Launch';
import { buildPlan, FPS, timeline } from './plan';

/** The clips' manifest comes in as input props (scripts/render.mjs reads public/clips/manifest.json). */
const length = ({ props }: { props: LaunchProps }) => ({ durationInFrames: timeline(buildPlan(props.manifest)).total });

export function Root() {
  return (
    <>
      <Composition id="launch-16x9" component={Launch} width={1920} height={1080} fps={FPS} durationInFrames={FPS} defaultProps={{ manifest: {}, vertical: false }} calculateMetadata={length} />
      <Composition id="launch-9x16" component={Launch} width={1080} height={1920} fps={FPS} durationInFrames={FPS} defaultProps={{ manifest: {}, vertical: true }} calculateMetadata={length} />
    </>
  );
}
