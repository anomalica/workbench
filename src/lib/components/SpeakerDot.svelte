<script lang="ts">
  import { speakerColour, isDefaultSpeakerName } from "$lib/transcript";

  let {
    speaker,
    size = "sm",
    inline = false,
    ring = false,
  }: {
    speaker: string;
    size?: "sm" | "md";
    inline?: boolean;
    ring?: boolean;
  } = $props();
</script>

<span
  class="rounded-full inline-block
    {size === 'sm' ? 'w-2 h-2' : 'w-3 h-3'}
    {inline ? 'mr-2 align-middle' : 'flex-none'}
    {isDefaultSpeakerName(speaker) ? 'opacity-50' : ''}
    {ring ? 'ring-2 ring-primary' : ''}"
  style="background-color: {speakerColour(speaker)}"
  data-testid="speaker-dot"
  data-speaker={speaker}
></span>
