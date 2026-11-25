import { createContext } from 'react'

/**
 * Every image of the chat shown, in the order it shows them: what the image
 * viewer steps through (components/Thumbnails.tsx). Without it, the viewer
 * steps through the images beside the one opened.
 */
export const ChatImages = createContext<string[]>([])
