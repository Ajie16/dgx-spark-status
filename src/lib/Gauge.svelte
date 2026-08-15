<script>
  export let value = 0;
  export let max = 100;
  export let size = 120;
  export let thickness = 10;
  export let color = '#30d158';
  export let label = '';
  export let yellowThreshold = 70;
  export let redThreshold = 90;

  $: percentage = Math.min((value / max) * 100, 100);
  $: radius = (size - thickness) / 2;
  $: circumference = 2 * Math.PI * radius;
  $: offset = circumference - (percentage / 100) * circumference;
  $: center = size / 2;

  // Calculate threshold angles (starting from -90 degrees, going clockwise)
  $: yellowAngle = -90 + (yellowThreshold / 100) * 360;
  $: redAngle = -90 + (redThreshold / 100) * 360;

  // Calculate line end points
  function getLineCoords(angle, innerRadius, outerRadius) {
    const rad = (angle * Math.PI) / 180;
    return {
      x1: center + innerRadius * Math.cos(rad),
      y1: center + innerRadius * Math.sin(rad),
      x2: center + outerRadius * Math.cos(rad),
      y2: center + outerRadius * Math.sin(rad)
    };
  }

  $: yellowLine = getLineCoords(yellowAngle, radius - thickness / 2, radius + thickness / 2);
  $: redLine = getLineCoords(redAngle, radius - thickness / 2, radius + thickness / 2);
</script>

<div class="gauge" style="width: {size}px; height: {size}px;">
  <svg width={size} height={size}>
    <!-- Background circle -->
    <circle
      cx={center}
      cy={center}
      r={radius}
      fill="none"
      stroke="var(--bg-subtle)"
      stroke-width={thickness}
    />
    <!-- Progress circle -->
    <circle
      cx={center}
      cy={center}
      r={radius}
      fill="none"
      stroke={color}
      stroke-width={thickness}
      stroke-dasharray={circumference}
      stroke-dashoffset={offset}
      stroke-linecap="round"
      transform="rotate(-90 {center} {center})"
      class="progress-circle"
    />
    <!-- Yellow threshold line -->
    <line
      x1={yellowLine.x1}
      y1={yellowLine.y1}
      x2={yellowLine.x2}
      y2={yellowLine.y2}
      stroke="rgba(255, 214, 10, 0.5)"
      stroke-width="1.5"
      stroke-linecap="round"
    />
    <!-- Red threshold line -->
    <line
      x1={redLine.x1}
      y1={redLine.y1}
      x2={redLine.x2}
      y2={redLine.y2}
      stroke="rgba(255, 69, 58, 0.5)"
      stroke-width="1.5"
      stroke-linecap="round"
    />
  </svg>
  <div class="gauge-content">
    <div class="gauge-value">{value}{label}</div>
  </div>
</div>

<style>
  .gauge {
    position: relative;
    display: inline-block;
  }

  .progress-circle {
    transition: stroke-dashoffset 0.4s cubic-bezier(0.25, 0.1, 0.25, 1);
  }

  .gauge-content {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
  }

  .gauge-value {
    font-size: 1.3rem;
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1;
    font-feature-settings: 'tnum';
    letter-spacing: -0.02em;
  }
</style>
