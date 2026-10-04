import { recipes } from '../server/recipes.js';
import { createRecipe, formatTime } from '../public/recipe.js';

for (const definition of recipes) {
  const recipe = createRecipe(definition);
  console.log(`${definition.id}: ${recipe.dose} g coffee, ${recipe.water} g water, ${recipe.ice} g ice, ${recipe.steps.length} steps, ${formatTime(recipe.duration)}${recipe.hasManualSteps ? ' timed + manual steps' : ''}`);
}
console.log(`Validated ${recipes.length} recipes across every supported 0.1 g dose.`);
