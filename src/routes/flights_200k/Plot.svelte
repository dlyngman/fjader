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
        // const plot = vg.plot(
        //   vg.areaY(vg.from("athletes", { filterBy: selection }), {
        //     x: vg.dateMonthDay("date"),
        //     y1: vg.max("temp_max"),
        //     y2: vg.min("temp_min"),
        //     fill: "#ccc",
        //     fillOpacity: 0.25,
        //   }),
        //   vg.areaY(vg.from("athletes", { filterBy: selection }), {
        //     x: vg.dateMonthDay("date"),
        //     y1: vg.avg("temp_max"),
        //     y2: vg.avg("temp_min"),
        //     fill: "steelblue",
        //     fillOpacity: 0.75,
        //   }),
        //   vg.intervalY({ as: selection }),
        //   vg.xyDomain(vg.Fixed),
        //   vg.yLabel("Temperature Range (°C)"),
        //   vg.width(680),
        //   vg.height(300)
        // );
        // const _category = vg.Selection.intersect();
        // const _query = vg.Selection.intersect({include: [_category]});
        const _hover = vg.Selection.intersect({empty: true});

        const _brush = vg.Selection.crossfilter();

        const plot = vg.hconcat(
        vg.vconcat(
            vg.plot(
                vg.rectY(
                    vg.from("flights", {filterBy: selection}),
                    {x: vg.bin("distance"), y: vg.count(), fill: 'red', nbin: 50}
                ),
                vg.intervalX({as: selection}),
                vg.xDomain(vg.Fixed),
                // vg.xyDomain(vg.Fixed),
                // vg.colorDomain(vg.Fixed),
                vg.margins({left: 35, top: 20, right: 1}),
                vg.width(570),
                vg.height(350)
            ),
            // vg.vspace(5),
            // vg.plot(
            //     vg.dot(
            //         vg.from("athletes", {filterBy: _query}),
            //         {x: "weight", y: "height", fill: "sex", r: 2, opacity: 0.1}
            //     ),
            //     vg.regressionY(
            //         vg.from("athletes", {filterBy: _query}),
            //         {x: "weight", y: "height", stroke: "sex"}
            //     ),
            //     vg.intervalXY({as: _query, brush: {fillOpacity: 0, stroke: "black"}}),
            //     vg.dot(
            //         vg.from("athletes", {filterBy: _hover}),
            //         {
            //         x: "weight",
            //         y: "height",
            //         fill: "sex",
            //         stroke: "currentColor",
            //         strokeWidth: 1,
            //         r: 3
            //         }
            //     ),
            //     vg.xyDomain(vg.Fixed),
            //     vg.colorDomain(vg.Fixed),
            //     vg.margins({left: 35, top: 20, right: 1}),
            //     vg.width(570),
            //     vg.height(350)
            // ),
            vg.vspace(5),
            vg.table({
                from: "flights",
                // maxWidth: 1000,
                height: 250,
                filterBy: selection,
                as: _hover,
                // columns: ["name", "nationality", "sex", "height", "weight", "sport"],
                // width: {name: 180, nationality: 100, sex: 50, height: 50, weight: 50, sport: 100}
            })
        )
        );
        container.appendChild(plot);
      });
    });
  </script>
  
  <div bind:this={container}></div>