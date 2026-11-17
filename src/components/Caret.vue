<template>
  <!-- The turn's heartbeat, drawn where the harness itself draws one: a block
       cursor that blinks for as long as something is being written. -->
  <span class="caret" aria-hidden="true"></span>
</template>

<style scoped>
.caret {
  display: inline-block;
  width: 8px;
  height: 15px;
  background: var(--text);
  vertical-align: text-bottom;
  animation: opencode-blink 1s step-start infinite;
}
@keyframes opencode-blink {
  50% {
    opacity: 0;
  }
}
</style>
