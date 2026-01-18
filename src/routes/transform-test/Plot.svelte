<script>
    import { getContext, onMount, onDestroy } from 'svelte';
    import * as _vg from "@uwdata/vgplot";
    import { createAPIContext } from "@uwdata/vgplot";
  
    const { selection } = $props();

    const coordinator = getContext('mosaic-coordinator');
    const vg = createAPIContext({
        coordinator: coordinator
    });
  
    let container;
  
    onMount(() => {
      $effect(() => {
        // console.log('plot effect')
        const _hover = vg.Selection.intersect({empty: true});

        const _brush = vg.Selection.crossfilter();

        const plot = vg.hconcat(
        vg.hconcat(
            vg.plot(
                vg.rectY(
                    vg.from("penguins", {filterBy: selection}),
                    {x: vg.bin("bill_depth"), y: vg.count(), fill: 'red', nbin: 50}
                ),
                vg.intervalX({as: selection}),
                vg.xDomain(vg.Fixed),
                // vg.xyDomain(vg.Fixed),
                // vg.colorDomain(vg.Fixed),
                vg.margins({left: 35, top: 20, right: 1}),
                vg.width(570),
                vg.height(350)
            ),
            vg.plot(
                vg.rectY(
                    vg.from("penguins", {filterBy: selection}),
                    {x: vg.bin("bill_length"), y: vg.count(), fill: 'red', nbin: 50}
                ),
                vg.intervalX({as: selection}),
                vg.xDomain(vg.Fixed),
                // vg.xyDomain(vg.Fixed),
                // vg.colorDomain(vg.Fixed),
                vg.margins({left: 35, top: 20, right: 1}),
                vg.width(570),
                vg.height(350)
            ),
            vg.plot(
                vg.rectY(
                    vg.from("penguins", {filterBy: selection}),
                    {x: vg.bin("body_mass"), y: vg.count(), fill: 'red', nbin: 50}
                ),
                vg.intervalX({as: selection}),
                vg.xDomain(vg.Fixed),
                // vg.xyDomain(vg.Fixed),
                // vg.colorDomain(vg.Fixed),
                vg.margins({left: 35, top: 20, right: 1}),
                vg.width(570),
                vg.height(350)
            )
        )
        );
        container.appendChild(plot);
      });
    });
  </script>
  
  <div bind:this={container}></div>