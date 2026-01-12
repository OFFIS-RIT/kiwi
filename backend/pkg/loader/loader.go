package loader

import (
	"context"
)

type GraphFileType string

const (
	GraphFileTypeImage    GraphFileType = "image"
	GraphFileTypeDocument GraphFileType = "document"
	GraphFileTypeAudio    GraphFileType = "audio"
	GraphFileTypeFile     GraphFileType = "file"
	GraphFileTypeCSV      GraphFileType = "csv"
)

type GraphBase64 struct {
	Base64   string `json:"base64"`
	FileType string `json:"file_type"`
}

// GraphFile represents a file that can be processed into text units
// for graph construction. It contains metadata such as the file path,
// maximum token limit, and optional custom entities.
//
// The actual file content is retrieved via the associated GraphFileLoader.
type GraphFile struct {
	ID             string
	FilePath       string
	FileType       GraphFileType
	MaxTokens      int
	CustomEntities []string
	Loader         GraphFileLoader
	Description    string
}

// NewGraphFileParams defines the input parameters for creating a new GraphFile
// instance. It is used by the constructor functions to initialize GraphFile
// values with consistent metadata and loader configuration.
type NewGraphFileParams struct {
	ID             string
	FilePath       string
	MaxTokens      int
	CustomEntities []string
	Loader         GraphFileLoader
}

// NewGraphImageFile creates a new GraphFile of type GraphFileTypeImage
// using the provided parameters. This is typically used for image files
// that require OCR or other image-to-text processing.
func NewGraphImageFile(
	params NewGraphFileParams,
) GraphFile {
	return GraphFile{
		ID:             params.ID,
		FilePath:       params.FilePath,
		FileType:       GraphFileTypeImage,
		MaxTokens:      params.MaxTokens,
		Loader:         params.Loader,
		CustomEntities: params.CustomEntities,
	}
}

// NewGraphDocumentFile creates a new GraphFile of type GraphFileTypeDocument
// using the provided parameters. This is typically used for text-based
// documents such as PDFs, Word files, or plain text files.
func NewGraphDocumentFile(
	params NewGraphFileParams,
) GraphFile {
	return GraphFile{
		ID:             params.ID,
		FilePath:       params.FilePath,
		FileType:       GraphFileTypeDocument,
		MaxTokens:      params.MaxTokens,
		Loader:         params.Loader,
		CustomEntities: params.CustomEntities,
	}
}

// NewGraphAudioFile creates a new GraphFile of type GraphFileTypeAudio
// using the provided parameters. This is used for audio files that require
// speech-to-text processing.
func NewGraphAudioFile(
	params NewGraphFileParams,
) GraphFile {
	return GraphFile{
		ID:             params.ID,
		FilePath:       params.FilePath,
		FileType:       GraphFileTypeAudio,
		MaxTokens:      params.MaxTokens,
		Loader:         params.Loader,
		CustomEntities: params.CustomEntities,
	}
}

// NewGraphGenericFile creates a new GraphFile of type GraphFileTypeFile
// with an additional description field. This constructor is useful for
// arbitrary file types that do not fall under image or document categories.
func NewGraphGenericFile(
	params NewGraphFileParams,
	description string,
) GraphFile {
	return GraphFile{
		ID:             params.ID,
		FilePath:       params.FilePath,
		FileType:       GraphFileTypeFile,
		MaxTokens:      params.MaxTokens,
		Loader:         params.Loader,
		CustomEntities: params.CustomEntities,
		Description:    description,
	}
}

// NewGraphCSVFile creates a new GraphFile of type GraphFileTypeCSV.
func NewGraphCSVFile(params NewGraphFileParams) GraphFile {
	return GraphFile{
		ID:             params.ID,
		FilePath:       params.FilePath,
		FileType:       GraphFileTypeCSV,
		MaxTokens:      params.MaxTokens,
		Loader:         params.Loader,
		CustomEntities: params.CustomEntities,
	}
}

// GetText retrieves the raw text content of the file using its Loader.
//
// Example:
//
//	text, err := file.GetText(ctx)
//	if err != nil {
//		log.Fatal(err)
//	}
//	fmt.Println(string(text))
func (f *GraphFile) GetText(ctx context.Context) ([]byte, error) {
	if f.FileType == GraphFileTypeFile {
		return []byte(f.Description), nil
	}
	return f.Loader.GetFileText(ctx, *f)
}

// GetBase64 retrieves the base64-encoded content of the file using its Loader.
// This is useful for transmitting binary file contents in a text-safe format.
func (f *GraphFile) GetBase64(ctx context.Context) (GraphBase64, error) {
	return f.Loader.GetBase64(ctx, *f)
}

// GraphFileLoader defines the interface for loading the contents of a GraphFile.
// Implementations may load files from disk, cloud storage, or other sources.
type GraphFileLoader interface {
	GetFileText(ctx context.Context, file GraphFile) ([]byte, error)
	GetBase64(ctx context.Context, file GraphFile) (GraphBase64, error)
}
