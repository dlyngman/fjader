<script lang="ts">
    let { 
      options = [], 
      value = '',
      label = 'Select an option',
      onChange = (value: string) => {}
    } = $props<{
      options: Array<{value: string, label: string}>,
      value: string,
      label: string,
      onChange: (value: string) => void
    }>();
  
    function handleChange(event: Event) {
      const target = event.target as HTMLSelectElement;
      onChange(target.value);
    }
  </script>
  
  <div class="selector-container">
    <label for="selector">{label}</label>
    <select id="selector" value={value} onchange={handleChange}>
      {#each options as option}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  </div>
  
  <style>
    .selector-container {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
  
    label {
      font-size: 14px;
      color: var(--gray-8, #333);
    }
  
    select {
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid var(--gray-4, #ccc);
      background-color: white;
      font-size: 14px;
      min-width: 150px;
    }
  </style>