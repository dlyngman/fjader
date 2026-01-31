# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///

import os
import sys

# List files to be included in xml tags:
file_list = [
    # 'README.md',
    # 'src/lib/gpu/GPUCoordinator.svelte.js',
    'src/lib/gpu/*',
    'src/lib/scales/LinearScaleState.svelte.js',
    'src/lib/scales/BandScaleState.svelte.js',
    'src/lib/scales/ColorScaleState.svelte.js',
    'src/lib/scales/color-utils.js',
    'src/lib/animation/AnimationLoop.js',
    'src/lib/animation/Spring.js',
    # 'src/lib/scales/PointerInputProcessor.js',
    'src/lib/scales/ChartScales.svelte.js',
    'src/lib/scales/ScaleRegistry.svelte.js',
    'src/lib/layout/ChartLayout.svelte.js',
    'src/lib/components/charts/ChartContainer.svelte',
    'src/lib/components/rendering/*',
    'src/lib/components/marks/*',
    'src/lib/components/guides/*',
    # 'src/lib/components/marks/BaseMarkSetup.svelte.js',
    # 'src/lib/components/marks/DotsMark.svelte',
    # 'src/lib/components/marks/BarMarkX.svelte',
    'src/lib/data/*',
    'src/lib/sql/*',
    'src/lib/transforms/*',
    # 'src/lib/gpu/ScaleTemplateSystem.js',
    'src/routes/scatter_plot_matrix/*',
    # 'src/routes/bar_chart/*',
]

def combine_files_to_xml(file_paths, output_path):
    # Expand paths containing wildcards and directories
    expanded_paths = []
    for path in file_paths:
        # Handle wildcard paths
        if path.endswith('*'):
            dir_path = os.path.dirname(path[:-1])
            if not dir_path:
                dir_path = '.'
                
            # Find all files, including those in subdirectories
            for root, _, files in os.walk(dir_path):
                for file in files:
                    expanded_paths.append(os.path.join(root, file))
        
        # Check if path is a directory
        elif os.path.isdir(path):
            # Find all files, including those in subdirectories
            for root, _, files in os.walk(path):
                for file in files:
                    expanded_paths.append(os.path.join(root, file))
        
        # Regular file path
        else:
            expanded_paths.append(path)
    
    with open(output_path, 'w') as output_file:
        for file_path in expanded_paths:
            # Create XML tag from file path
            tag = file_path
            
            # Read file contents
            try:
                with open(file_path, 'r') as input_file:
                    content = input_file.read()
                
                # Add indentation to each line of content
                indented_content = ""
                for line in content.splitlines():
                    indented_content += "  " + line + "\n"
                
                # Write to output with XML tags
                output_file.write(f"<{tag}>\n")
                output_file.write(indented_content)
                output_file.write(f"</{tag}>\n\n")
            except Exception as e:
                print(f"Error processing {file_path}: {e}", file=sys.stderr)


if __name__ == "__main__":
    # Example usage
    files_to_combine = file_list
    
    output_xml = "llm_context.txt"
    combine_files_to_xml(files_to_combine, output_xml)
    print(f"Combined files saved to {output_xml}")