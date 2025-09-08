<script>
  import { Coordinator, coordinator, wasmConnector } from "@uwdata/mosaic-core";
  import { loadCSV, loadParquet } from "@uwdata/mosaic-sql";
  // import { setScaleRegistry } from "$lib/scales";
  import { setCoordinators } from "$lib";
  import { onMount, onDestroy, setContext } from "svelte";
  import MainView from "./MainView.svelte";
  
  // setScaleRegistry();
  setCoordinators();

  let coord;
  // setContext('mosaic-coordinator', coord);

  let isLoaded = $state(false);
  let loadError = $state(null);

  const logs = [];
  const queryLogger = {
    ...console,

    debug(...values) {
      if (values.length > 0 && typeof values[0] === 'string' && values[0].includes('Query')) {
        const queryLog = values[1];

        if (queryLog && queryLog.sql) {
          const timestamp = new Date().toLocaleTimeString('sv-SE', { hour12: false});
          console.log(`[${timestamp}] \n${queryLog.sql}`);
          logs.push({ query: queryLog.sql, time: new Date()})
        }
      }
    },
    getLogs() {
      return logs;
    }
  };

  onMount(async () => {
    try {
      const wasm = wasmConnector();
      coord = new Coordinator();
      coord.databaseConnector(wasm);

      coord.manager.logQueries(true);
      coord.manager.logger(queryLogger);
    
      setContext('mosaic-coordinator', coord);


      await coord.exec(
        loadParquet("flights", `${window.location.origin}/data/flights-200k.parquet`)

      );

      isLoaded = true
    } catch (error) {
      console.error("Initialization error:", error);
      loadError = error.message;
    }
  });
</script>

<div class="app-container">
  {#if loadError}
    <div class="error-container">Error loading data: {loadError}</div>
  {:else if !isLoaded}
    <div class="loading-container">Loading parquet data...</div>
  {:else}
    <MainView />
  {/if}
</div>


<style>
  .app-container {
    width: 100%;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .loading-container,
  .error-container {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 200px;
    padding: 2rem;
  }
</style>