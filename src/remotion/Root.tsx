import { Composition } from 'remotion';
import { GlobeVideo, type GlobeVideoProps } from './GlobeVideo';
import { DEFAULT_VALUES } from '../lib/dialConfig';
import { durationSeconds, outputSize, toStage } from '../lib/settings';
import './remotion.css';

/** Size, fps and length all come from the panel JSON rather than being pinned here. */
function metadata({ props }: { props: GlobeVideoProps }) {
  const settings = toStage(props.values);
  const { width, height } = outputSize(settings);
  const fps = settings.record.fps;
  return {
    width,
    height,
    fps,
    durationInFrames: Math.max(1, Math.round(durationSeconds(settings) * fps)),
  };
}

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="GlobeVideo"
        component={GlobeVideo}
        defaultProps={{ values: DEFAULT_VALUES }}
        calculateMetadata={metadata}
        width={1800}
        height={1800}
        fps={60}
        durationInFrames={1440}
      />
      <Composition
        id="GlobeStill"
        component={GlobeVideo}
        defaultProps={{ values: DEFAULT_VALUES }}
        calculateMetadata={({ props }) => ({ ...metadata({ props }), durationInFrames: 1 })}
        width={1800}
        height={1800}
        fps={60}
        durationInFrames={1}
      />
    </>
  );
};
