namespace __NAMESPACE__

ConceptTaxonomy(ConceptTaxonomy): ConceptType
	hypernymPredicate: isA

Topic(Topic): EntityType
	properties:
		description(description): Text
		name(name): Text
		semanticType(semanticType): Text
			index: Text
		topicSlug(topicSlug): Text
			index: Text
		usageCount(usageCount): Text
		summary(summary): Text
			index: TextAndVector

ReferenceDocument(ReferenceDocument): EntityType
	properties:
		description(description): Text
		name(name): Text
		semanticType(semanticType): Text
			index: Text
		sourceUrl(sourceUrl): Text
			index: Text
		sourceType(sourceType): Text
		documentCategory(documentCategory): Text
			index: Text
		language(language): Text
		sourceTier(sourceTier): Text
		publishedAt(publishedAt): Text
		retrievedAt(retrievedAt): Text
		topicRefIds(topicRefIds): Text
		conceptRefIds(conceptRefIds): Text
		content(content): Text
		contentPreview(contentPreview): Text
			index: TextAndVector
		contentHash(contentHash): Text
			index: Text
		contentLength(contentLength): Text
		summary(summary): Text
			index: TextAndVector

Chunk(Chunk): EntityType
	properties:
		description(description): Text
		name(name): Text
		semanticType(semanticType): Text
			index: Text
		sourceDocumentRefId(sourceDocumentRefId): Text
			index: Text
		sourceUrl(sourceUrl): Text
			index: Text
		sectionHeading(sectionHeading): Text
		sectionOrder(sectionOrder): Text
		content(content): Text
			index: TextAndVector
		contentPreview(contentPreview): Text
		contentHash(contentHash): Text
			index: Text
		contentLength(contentLength): Text
