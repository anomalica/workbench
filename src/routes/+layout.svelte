<script lang="ts">
	import '$lib/styles/app.css';
	let { children } = $props();
</script>

<svelte:head>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Noto+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
	<title>Anomalica Workbench</title>
</svelte:head>

<div class="min-h-screen flex flex-col">
	<header class="bg-teal-950 text-teal-300 px-6 py-3 font-ui flex items-center gap-3">
		<span class="text-lg font-semibold tracking-wide">Anomalica</span>
		<span class="text-teal-500 text-sm">Workbench</span>
	</header>

	<main class="flex-1">
		{@render children()}
	</main>
</div>
