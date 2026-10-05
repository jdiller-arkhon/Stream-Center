import type { YouTubeKit } from '../shared/contracts';

/** Drafts a description from what the kit knows about the video (no AI involved). */
export function suggestDescription(kit: Pick<YouTubeKit, 'game' | 'isShort' | 'title'>, variant: number): string {
    const game = kit.game?.trim();
    const subject = game ? `${game} gameplay` : 'video game';
    const ideas = [
        `epic moment in ${subject}, the hero mid-action, explosions and flying debris, dynamic low camera angle, glowing particles`,
        `${subject} victory scene, character silhouetted against a blazing sunset, dramatic sky, sense of triumph`,
        `intense close-up of a ${game ? `${game} ` : ''}character's determined face, battlefield blurred behind, high tension`,
        `wide shot of a huge ${game ? `${game} ` : 'fantasy '}arena at night, spotlights, smoke, crowd of silhouettes, anticipation`,
        `chaotic ${subject} fight, multiple enemies charging, motion blur, sparks, bold contrasting colors`,
    ];
    return ideas[variant % ideas.length]!;
}
