package graph

import (
	"kiwi/pkg/common"
)

func mergeEntitiesAndRelations(
	entities []common.Entity,
	newEntities []common.Entity,
	relations []common.Relationship,
	newRelations []common.Relationship,
) ([]common.Entity, []common.Relationship) {
	for _, entity := range newEntities {
		found := false
		for j := range entities {
			if entities[j].Name == entity.Name {
				entities[j].Sources = append(entities[j].Sources, entity.Sources...)
				found = true
				break
			}
		}
		if !found {
			entities = append(entities, entity)
		}
	}

	entityMap := make(map[string]*common.Entity)
	for i := range entities {
		entityMap[entities[i].Name] = &entities[i]
	}

	for _, rel := range newRelations {
		if rel.Source == nil || rel.Target == nil {
			continue
		}
		sr, tr := entityMap[rel.Source.Name], entityMap[rel.Target.Name]
		if sr == nil || tr == nil {
			continue
		}

		rel.Source = sr
		rel.Target = tr

		found := false
		for j := range relations {
			if relations[j].Source == nil || relations[j].Target == nil {
				continue
			}
			src1, tgt1 := relations[j].Source.Name, relations[j].Target.Name
			src2, tgt2 := rel.Source.Name, rel.Target.Name

			if (src1 == src2 && tgt1 == tgt2) ||
				(src1 == tgt2 && tgt1 == src2) {
				relations[j].Sources = append(relations[j].Sources, rel.Sources...)
				relations[j].Strength = (relations[j].Strength + rel.Strength) / 2
				found = true
				break
			}
		}

		if !found {
			relations = append(relations, rel)
		}
	}

	return entities, relations
}
