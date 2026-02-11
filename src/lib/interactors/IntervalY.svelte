<script>
	import Interval1D from './Interval1D.svelte';
	let { bridge, field } = $props();
</script>

<Interval1D {bridge} {field} axis="y" />
